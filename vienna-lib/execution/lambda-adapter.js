/**
 * Lambda Adapter — Managed Execution via AWS Lambda / GCP Cloud Functions
 * 
 * Vienna invokes serverless functions directly as managed execution targets.
 * Supports:
 *   - AWS Lambda (invoke via SDK or HTTP)
 *   - GCP Cloud Functions (HTTP trigger)
 *   - Generic serverless (HTTP POST)
 * 
 * Retry: exponential backoff, max 2 retries.
 */

const crypto = require('crypto');

class LambdaAdapter {
  constructor(options = {}) {
    this.defaultTimeout = options.timeoutMs || 30000; // 30s for serverless
    this.maxRetries = options.maxRetries || 2;
    this.auditLog = options.auditLog || null;
  }

  /**
   * Execute via serverless function
   * 
   * @param {object} adapterConfig - Lambda/function config
   * @param {object} executionPayload - Execution instruction
   * @returns {Promise<object>} Execution result
   */
  async execute(adapterConfig, executionPayload) {
    const executionId = executionPayload.execution_id || this._generateId();
    const startTime = Date.now();

    // Route based on provider
    const provider = adapterConfig.provider || this._detectProvider(adapterConfig);
    
    let result;
    switch (provider) {
      case 'aws_lambda':
        result = await this._invokeAWSLambda(adapterConfig, executionPayload, executionId);
        break;
      case 'gcp_function':
      case 'http':
      default:
        // GCP functions and generic serverless use HTTP invocation
        result = await this._invokeHTTP(adapterConfig, executionPayload, executionId);
        break;
    }

    result.metadata = {
      ...result.metadata,
      provider,
      total_latency_ms: Date.now() - startTime
    };

    return result;
  }

  /**
   * Invoke via HTTP (GCP Cloud Functions, generic serverless)
   */
  async _invokeHTTP(config, payload, executionId) {
    let lastError = null;
    let attempt = 0;

    while (attempt <= this.maxRetries) {
      attempt++;
      const attemptStart = Date.now();

      try {
        const headers = {
          'Content-Type': 'application/json',
          'X-Vienna-Execution-Id': executionId,
          ...(config.headers || {})
        };

        if (config.auth_type === 'bearer' && config.encrypted_credentials?.token) {
          headers['Authorization'] = `Bearer ${config.encrypted_credentials.token}`;
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

          const latencyMs = Date.now() - attemptStart;
          await this._log({ execution_id: executionId, adapter_type: 'lambda', attempt, latency_ms: latencyMs, status: response.status >= 200 && response.status < 300 ? 'success' : 'failure' });

          if (response.status >= 200 && response.status < 300) {
            return {
              success: true,
              execution_id: executionId,
              adapter_type: 'lambda',
              receipt: {
                hash: this._hash(parsed, executionId),
                response_body: parsed,
                http_status: response.status
              },
              metadata: { endpoint: config.endpoint_url, attempts: attempt }
            };
          }

          lastError = `HTTP ${response.status}`;
        } finally {
          clearTimeout(timeout);
        }

      } catch (error) {
        lastError = error.message;
        await this._log({ execution_id: executionId, adapter_type: 'lambda', attempt, status: 'error', error: error.message });
      }

      if (attempt <= this.maxRetries) {
        await new Promise(r => setTimeout(r, Math.min(1000 * Math.pow(2, attempt - 1), 8000)));
      }
    }

    return {
      success: false,
      execution_id: executionId,
      adapter_type: 'lambda',
      error: lastError,
      metadata: { endpoint: config.endpoint_url, attempts: attempt }
    };
  }

  /**
   * Invoke AWS Lambda (via HTTP gateway — no SDK dependency)
   * Uses Lambda function URL or API Gateway endpoint
   */
  async _invokeAWSLambda(config, payload, executionId) {
    // AWS Lambda function URLs are just HTTP POST endpoints
    // For direct invoke via SDK, customer would use a webhook adapter wrapping the SDK
    return this._invokeHTTP(config, payload, executionId);
  }

  _detectProvider(config) {
    const url = config.endpoint_url || '';
    if (url.includes('.lambda-url.') || url.includes('.execute-api.')) return 'aws_lambda';
    if (url.includes('cloudfunctions.net') || url.includes('run.app')) return 'gcp_function';
    return 'http';
  }

  _hash(data, executionId) {
    return crypto.createHash('sha256').update(JSON.stringify({ data, executionId })).digest('hex').substring(0, 16);
  }

  async _log(entry) {
    if (this.auditLog) {
      try {
        await this.auditLog.emit({ event_type: 'lambda_execution', timestamp: new Date().toISOString(), ...entry });
      } catch (e) { /* swallow */ }
    }
  }

  _generateId() {
    return `lex_${crypto.randomBytes(12).toString('hex')}`;
  }
}

module.exports = { LambdaAdapter };
