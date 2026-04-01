/**
 * Webhook Adapter — Managed Execution
 * 
 * Vienna executes directly via customer-provided HTTP endpoints.
 * Supports bearer, basic, and no-auth modes.
 * 
 * Retry: exponential backoff, max 2 retries.
 * Timeout: 10s per attempt (configurable).
 */

const crypto = require('crypto');

class WebhookAdapter {
  constructor(options = {}) {
    this.defaultTimeout = options.timeoutMs || 10000;
    this.maxRetries = options.maxRetries || 2;
    this.auditLog = options.auditLog || null;
  }

  /**
   * Execute via webhook
   * 
   * @param {object} adapterConfig - From adapter_configs table
   * @param {object} executionPayload - Execution instruction
   * @returns {Promise<object>} Execution result with receipt
   */
  async execute(adapterConfig, executionPayload) {
    const executionId = executionPayload.execution_id || this._generateId();
    const startTime = Date.now();
    let lastError = null;
    let attempt = 0;

    while (attempt <= this.maxRetries) {
      attempt++;
      const attemptStart = Date.now();

      try {
        const result = await this._sendRequest(adapterConfig, executionPayload, attempt);
        const latencyMs = Date.now() - attemptStart;

        await this._logExecution({
          execution_id: executionId,
          adapter_type: 'webhook',
          attempt,
          latency_ms: latencyMs,
          status: result.success ? 'success' : 'failure',
          response_status: result.httpStatus,
          error: result.success ? null : result.error
        });

        if (result.success) {
          return {
            success: true,
            execution_id: executionId,
            adapter_type: 'webhook',
            receipt: {
              hash: this._hashReceipt(result.body, executionId),
              response_body: result.body,
              http_status: result.httpStatus,
              attempt,
              latency_ms: Date.now() - startTime
            },
            metadata: {
              endpoint: adapterConfig.endpoint_url,
              attempts: attempt,
              total_latency_ms: Date.now() - startTime
            }
          };
        }

        lastError = result.error;

      } catch (error) {
        lastError = error.message;
        const latencyMs = Date.now() - attemptStart;

        await this._logExecution({
          execution_id: executionId,
          adapter_type: 'webhook',
          attempt,
          latency_ms: latencyMs,
          status: 'error',
          error: error.message
        });
      }

      // Exponential backoff before retry
      if (attempt <= this.maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        await this._sleep(delay);
      }
    }

    // All retries exhausted
    return {
      success: false,
      execution_id: executionId,
      adapter_type: 'webhook',
      error: lastError || 'All retry attempts exhausted',
      metadata: {
        endpoint: adapterConfig.endpoint_url,
        attempts: attempt,
        total_latency_ms: Date.now() - startTime
      }
    };
  }

  /**
   * Send HTTP request to webhook endpoint
   */
  async _sendRequest(adapterConfig, payload, attempt) {
    const { endpoint_url, headers: configHeaders, auth_type, encrypted_credentials } = adapterConfig;
    
    const headers = {
      'Content-Type': 'application/json',
      'X-Vienna-Execution-Id': payload.execution_id,
      'X-Vienna-Attempt': String(attempt),
      ...(configHeaders || {})
    };

    // Apply auth
    if (auth_type === 'bearer' && encrypted_credentials?.token) {
      headers['Authorization'] = `Bearer ${encrypted_credentials.token}`;
    } else if (auth_type === 'basic' && encrypted_credentials?.username) {
      const encoded = Buffer.from(
        `${encrypted_credentials.username}:${encrypted_credentials.password}`
      ).toString('base64');
      headers['Authorization'] = `Basic ${encoded}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.defaultTimeout);

    try {
      const response = await fetch(endpoint_url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      const body = await response.text().catch(() => '');
      let parsedBody;
      try {
        parsedBody = JSON.parse(body);
      } catch {
        parsedBody = { raw: body };
      }

      const success = response.status >= 200 && response.status < 300;
      
      return {
        success,
        httpStatus: response.status,
        body: parsedBody,
        error: success ? null : `HTTP ${response.status}: ${body.substring(0, 500)}`
      };

    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Generate a receipt hash for verification
   */
  _hashReceipt(responseBody, executionId) {
    const data = JSON.stringify({ response: responseBody, execution_id: executionId });
    return crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);
  }

  async _logExecution(entry) {
    if (this.auditLog) {
      try {
        await this.auditLog.emit({
          event_type: 'webhook_execution',
          timestamp: new Date().toISOString(),
          ...entry
        });
      } catch (e) {
        // Don't fail on audit errors
      }
    }
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  _generateId() {
    return `wex_${crypto.randomBytes(12).toString('hex')}`;
  }
}

module.exports = { WebhookAdapter };
