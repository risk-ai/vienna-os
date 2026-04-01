/**
 * Delegated Adapter — STATELESS
 * 
 * Executes a single step by dispatching to an external agent endpoint,
 * then waiting for the agent's callback result.
 * 
 * This adapter does NOT own state. It receives a step, fires the request,
 * and returns a result. The ExecutionEngine owns all lifecycle.
 * 
 * Flow:
 *   Engine calls adapter.execute(step, execution)
 *   → Adapter POSTs to agent endpoint
 *   → Waits for callback (or polls)
 *   → Returns { success, receipt, metadata }
 */

const crypto = require('crypto');

class DelegatedAdapter {
  constructor(options = {}) {
    this.callbackBaseUrl = options.callbackBaseUrl || process.env.VIENNA_CALLBACK_URL || 'http://localhost:3000';
    this.defaultTimeoutMs = options.timeoutMs || 30000;
    
    // Pending callbacks: execution_id → { resolve, reject, timer }
    this.pendingCallbacks = new Map();
  }

  /**
   * Execute a step by dispatching to agent.
   * Called ONLY by ExecutionEngine.
   * 
   * @param {object} step - Step definition (from engine)
   * @param {object} execution - Parent execution context (read-only)
   * @returns {Promise<object>} { success, output, receipt, metadata }
   */
  async execute(step, execution) {
    const agentEndpoint = step.params.agent_endpoint;
    if (!agentEndpoint) {
      return { success: false, error: 'No agent_endpoint in step params' };
    }

    const instruction = {
      execution_id: execution.execution_id,
      step_index: step.index,
      action: step.action,
      params: step.params,
      constraints: step.params.constraints || {},
      callback_url: `${this.callbackBaseUrl}/api/v1/engine/callback`
    };

    const headers = {
      'Content-Type': 'application/json',
      'X-Vienna-Execution-Id': execution.execution_id,
      'X-Vienna-Step-Index': String(step.index)
    };

    // Apply auth from step params
    if (step.params.auth_type === 'bearer' && step.params.auth_token) {
      headers['Authorization'] = `Bearer ${step.params.auth_token}`;
    }

    const timeoutMs = step.params.timeout_ms || this.defaultTimeoutMs;

    try {
      // Create callback promise (agent will call back)
      const callbackPromise = this._waitForCallback(execution.execution_id, timeoutMs);

      // Dispatch to agent
      const dispatchResult = await this._httpPost(agentEndpoint, instruction, headers, 10000);

      if (dispatchResult.status < 200 || dispatchResult.status >= 300) {
        this._cancelCallback(execution.execution_id);
        return {
          success: false,
          error: `Agent rejected dispatch: HTTP ${dispatchResult.status}`,
          metadata: { http_status: dispatchResult.status }
        };
      }

      // Wait for agent callback
      const callbackResult = await callbackPromise;

      return {
        success: callbackResult.status === 'success',
        output: callbackResult.metadata || {},
        receipt: callbackResult.receipt || {},
        error: callbackResult.status !== 'success' ? (callbackResult.error || 'Agent reported failure') : null,
        metadata: {
          agent_endpoint: agentEndpoint,
          callback_received: true
        }
      };

    } catch (error) {
      this._cancelCallback(execution.execution_id);
      
      if (error.message === 'CALLBACK_TIMEOUT') {
        return {
          success: false,
          error: `Agent did not callback within ${timeoutMs}ms`,
          metadata: { timeout: true, timeout_ms: timeoutMs }
        };
      }

      return {
        success: false,
        error: error.message,
        metadata: { agent_endpoint: agentEndpoint }
      };
    }
  }

  /**
   * Receive a callback from an agent. Called by the HTTP endpoint handler.
   * Resolves the pending promise for the given execution.
   */
  receiveCallback(executionId, result) {
    const pending = this.pendingCallbacks.get(executionId);
    if (!pending) return false;

    clearTimeout(pending.timer);
    pending.resolve(result);
    this.pendingCallbacks.delete(executionId);
    return true;
  }

  // --- Internal ---

  _waitForCallback(executionId, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCallbacks.delete(executionId);
        reject(new Error('CALLBACK_TIMEOUT'));
      }, timeoutMs);

      this.pendingCallbacks.set(executionId, { resolve, reject, timer });
    });
  }

  _cancelCallback(executionId) {
    const pending = this.pendingCallbacks.get(executionId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingCallbacks.delete(executionId);
    }
  }

  async _httpPost(url, body, headers, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    } finally {
      clearTimeout(timeout);
    }
  }
}

module.exports = { DelegatedAdapter };
