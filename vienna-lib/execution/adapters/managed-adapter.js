/**
 * Managed Adapter — STATELESS
 * 
 * Executes a single step by calling a customer-provided HTTP endpoint
 * (webhook, Lambda, Cloud Function). Vienna holds the adapter config.
 * 
 * This adapter does NOT own state. The ExecutionEngine owns all lifecycle.
 * 
 * Supports:
 *   - Webhook (POST with auth)
 *   - AWS Lambda (function URL / API Gateway)
 *   - GCP Cloud Functions (HTTP trigger)
 *   - Generic HTTP POST
 * 
 * Retry: exponential backoff, max 2 retries.
 */

const crypto = require('crypto');

class ManagedAdapter {
  constructor(options = {}) {
    this.defaultTimeout = options.timeoutMs || 10000;
    this.maxRetries = options.maxRetries || 2;
    // Adapter configs registry (injected, engine or registry provides)
    this.configRegistry = options.configRegistry || null;
  }

  /**
   * Execute a step by calling a managed endpoint.
   * Called ONLY by ExecutionEngine.
   * 
   * @param {object} step - Step definition (from engine)
   * @param {object} execution - Parent execution context (read-only)
   * @returns {Promise<object>} { success, output, receipt, metadata }
   */
  async execute(step, execution) {
    // Resolve adapter config — either inline or from registry
    const adapterConfig = step.params.adapter_config
      || (step.params.adapter_id && this.configRegistry?.get(step.params.adapter_id))
      || null;

    if (!adapterConfig || !adapterConfig.endpoint_url) {
      return { success: false, error: 'No adapter_config or adapter_id with endpoint_url in step params' };
    }

    const payload = {
      execution_id: execution.execution_id,
      step_index: step.index,
      action: step.action,
      params: step.params,
      issued_at: new Date().toISOString()
    };

    let lastError = null;
    let attempt = 0;
    const startTime = Date.now();

    while (attempt <= this.maxRetries) {
      attempt++;

      try {
        const result = await this._sendRequest(adapterConfig, payload, attempt);

        if (result.success) {
          return {
            success: true,
            output: result.body,
            receipt: {
              hash: this._hash(result.body, execution.execution_id),
              http_status: result.httpStatus,
              response_body: result.body
            },
            metadata: {
              endpoint: adapterConfig.endpoint_url,
              attempts: attempt,
              latency_ms: Date.now() - startTime
            }
          };
        }

        lastError = result.error;

      } catch (error) {
        lastError = error.message;
      }

      // Exponential backoff before retry
      if (attempt <= this.maxRetries) {
        await new Promise(r => setTimeout(r, Math.min(1000 * Math.pow(2, attempt - 1), 5000)));
      }
    }

    return {
      success: false,
      error: lastError || 'All retry attempts exhausted',
      metadata: {
        endpoint: adapterConfig.endpoint_url,
        attempts: attempt,
        latency_ms: Date.now() - startTime
      }
    };
  }

  async _sendRequest(config, payload, attempt) {
    const headers = {
      'Content-Type': 'application/json',
      'X-Vienna-Execution-Id': payload.execution_id,
      'X-Vienna-Attempt': String(attempt),
      ...(config.headers || {})
    };

    if (config.auth_type === 'bearer' && config.encrypted_credentials?.token) {
      headers['Authorization'] = `Bearer ${config.encrypted_credentials.token}`;
    } else if (config.auth_type === 'basic' && config.encrypted_credentials?.username) {
      const encoded = Buffer.from(
        `${config.encrypted_credentials.username}:${config.encrypted_credentials.password}`
      ).toString('base64');
      headers['Authorization'] = `Basic ${encoded}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.defaultTimeout);

    try {
      const response = await fetch(config.endpoint_url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      const body = await response.text();
      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = { raw: body }; }

      return {
        success: response.status >= 200 && response.status < 300,
        httpStatus: response.status,
        body: parsed,
        error: response.status >= 300 ? `HTTP ${response.status}` : null
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  _hash(data, executionId) {
    return crypto.createHash('sha256')
      .update(JSON.stringify({ data, executionId }))
      .digest('hex')
      .substring(0, 16);
  }
}

module.exports = { ManagedAdapter };
