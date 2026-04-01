/**
 * Delegated Execution Protocol
 * 
 * Vienna issues execution instructions to external agents and verifies completion.
 * The agent holds the credentials; Vienna orchestrates and verifies.
 * 
 * Flow:
 *   1. Warrant approved → Execution instruction generated
 *   2. Instruction sent to agent's POST /execute endpoint
 *   3. Agent executes, returns result to POST /api/v1/execution/result
 *   4. Vienna verifies receipt → transitions state to complete/failed
 */

const crypto = require('crypto');

/**
 * Execution states for delegated execution
 */
const DELEGATED_STATES = {
  PLANNED: 'planned',
  APPROVED: 'approved',
  DISPATCHED: 'dispatched',              // instruction sent to agent
  EXECUTING: 'executing',                 // agent acknowledged, working
  VERIFYING: 'verifying',                 // result received, verifying
  COMPLETE: 'complete',
  FAILED: 'failed',
  TIMED_OUT: 'timed_out'
};

/**
 * Valid state transitions
 */
const VALID_TRANSITIONS = {
  [DELEGATED_STATES.PLANNED]:     [DELEGATED_STATES.APPROVED, DELEGATED_STATES.FAILED],
  [DELEGATED_STATES.APPROVED]:    [DELEGATED_STATES.DISPATCHED, DELEGATED_STATES.FAILED],
  [DELEGATED_STATES.DISPATCHED]:  [DELEGATED_STATES.EXECUTING, DELEGATED_STATES.FAILED, DELEGATED_STATES.TIMED_OUT],
  [DELEGATED_STATES.EXECUTING]:   [DELEGATED_STATES.VERIFYING, DELEGATED_STATES.FAILED, DELEGATED_STATES.TIMED_OUT],
  [DELEGATED_STATES.VERIFYING]:   [DELEGATED_STATES.COMPLETE, DELEGATED_STATES.FAILED],
  [DELEGATED_STATES.COMPLETE]:    [],
  [DELEGATED_STATES.FAILED]:      [],
  [DELEGATED_STATES.TIMED_OUT]:   []
};

class DelegatedExecution {
  constructor(options = {}) {
    this.executions = new Map();
    this.auditLog = options.auditLog || null;
    this.callbackBaseUrl = options.callbackBaseUrl || process.env.VIENNA_CALLBACK_URL || 'http://localhost:3000';
    this.defaultTimeoutMs = options.defaultTimeoutMs || 300000; // 5 min default
    this.timeouts = new Map();
  }

  /**
   * Translate an approved warrant into a structured execution instruction
   * 
   * @param {object} warrant - Approved warrant object
   * @param {object} options - Additional execution options
   * @returns {object} Execution instruction payload
   */
  createInstruction(warrant, options = {}) {
    const executionId = this._generateExecutionId();
    
    const instruction = {
      execution_id: executionId,
      warrant_id: warrant.id || warrant.warrant_id,
      action: options.action || warrant.allowedActions?.[0] || warrant.objective,
      params: options.params || warrant.constraints || {},
      constraints: {
        allowed_actions: warrant.allowedActions || [],
        forbidden_actions: warrant.forbiddenActions || [],
        risk_tier: warrant.riskTier || warrant.risk_tier || 'T1',
        max_retries: options.maxRetries || 2,
        timeout_ms: options.timeoutMs || this.defaultTimeoutMs,
        ...(options.constraints || {})
      },
      callback_url: `${this.callbackBaseUrl}/api/v1/execution/result`,
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + (options.timeoutMs || this.defaultTimeoutMs)).toISOString()
    };

    // Store execution state
    this.executions.set(executionId, {
      execution_id: executionId,
      warrant_id: instruction.warrant_id,
      state: DELEGATED_STATES.PLANNED,
      instruction,
      timeline: [{
        state: DELEGATED_STATES.PLANNED,
        timestamp: new Date().toISOString(),
        detail: 'Execution instruction created from warrant'
      }],
      result: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });

    return instruction;
  }

  /**
   * Dispatch instruction to agent endpoint
   * 
   * @param {string} executionId - Execution ID
   * @param {string} agentEndpoint - Agent's POST /execute URL
   * @param {object} options - Dispatch options (headers, auth)
   * @returns {Promise<object>} Dispatch result
   */
  async dispatch(executionId, agentEndpoint, options = {}) {
    const execution = this.executions.get(executionId);
    if (!execution) {
      throw new DelegatedExecutionError('NOT_FOUND', `Execution ${executionId} not found`);
    }

    this._transition(executionId, DELEGATED_STATES.APPROVED);

    const headers = {
      'Content-Type': 'application/json',
      'X-Vienna-Execution-Id': executionId,
      ...(options.headers || {})
    };

    // Add auth if configured
    if (options.authType === 'bearer' && options.token) {
      headers['Authorization'] = `Bearer ${options.token}`;
    } else if (options.authType === 'basic' && options.username && options.password) {
      const encoded = Buffer.from(`${options.username}:${options.password}`).toString('base64');
      headers['Authorization'] = `Basic ${encoded}`;
    }

    try {
      const response = await this._httpPost(agentEndpoint, execution.instruction, headers, options.timeoutMs || 10000);
      
      this._transition(executionId, DELEGATED_STATES.DISPATCHED, {
        detail: `Dispatched to ${agentEndpoint}`,
        response_status: response.status
      });

      // Start timeout timer
      this._startTimeout(executionId, execution.instruction.constraints.timeout_ms);

      await this._audit('delegated_execution_dispatched', {
        execution_id: executionId,
        agent_endpoint: agentEndpoint,
        response_status: response.status
      });

      return {
        success: true,
        execution_id: executionId,
        state: DELEGATED_STATES.DISPATCHED,
        dispatched_at: new Date().toISOString()
      };

    } catch (error) {
      this._transition(executionId, DELEGATED_STATES.FAILED, {
        detail: `Dispatch failed: ${error.message}`,
        error: error.message
      });

      await this._audit('delegated_execution_dispatch_failed', {
        execution_id: executionId,
        error: error.message
      });

      return {
        success: false,
        execution_id: executionId,
        state: DELEGATED_STATES.FAILED,
        error: error.message
      };
    }
  }

  /**
   * Process result from agent callback
   * 
   * @param {object} resultPayload - Agent's result payload
   * @returns {object} Verification result
   */
  async processResult(resultPayload) {
    const { execution_id, status, receipt, metadata } = resultPayload;

    if (!execution_id) {
      throw new DelegatedExecutionError('INVALID_RESULT', 'Missing execution_id');
    }

    const execution = this.executions.get(execution_id);
    if (!execution) {
      throw new DelegatedExecutionError('NOT_FOUND', `Execution ${execution_id} not found`);
    }

    // Clear timeout
    this._clearTimeout(execution_id);

    // Mark as executing if still dispatched (agent started work)
    if (execution.state === DELEGATED_STATES.DISPATCHED) {
      this._transition(execution_id, DELEGATED_STATES.EXECUTING, {
        detail: 'Agent began execution'
      });
    }

    // Transition to verifying
    this._transition(execution_id, DELEGATED_STATES.VERIFYING, {
      detail: 'Result received, verifying',
      agent_status: status
    });

    // Verify receipt integrity (stub — will be full crypto later)
    const receiptValid = this._verifyReceipt(receipt, execution);

    if (status === 'success' && receiptValid) {
      this._transition(execution_id, DELEGATED_STATES.COMPLETE, {
        detail: 'Execution verified complete',
        receipt_hash: receipt?.hash || null
      });

      execution.result = {
        status: 'success',
        receipt,
        metadata: metadata || {},
        completed_at: new Date().toISOString()
      };

      await this._audit('delegated_execution_complete', {
        execution_id,
        receipt_hash: receipt?.hash || 'none'
      });

      return {
        execution_id,
        verified: true,
        state: DELEGATED_STATES.COMPLETE
      };

    } else {
      const reason = !receiptValid ? 'Receipt verification failed' : `Agent reported: ${status}`;
      
      this._transition(execution_id, DELEGATED_STATES.FAILED, {
        detail: reason,
        agent_status: status
      });

      execution.result = {
        status: 'failed',
        reason,
        metadata: metadata || {},
        failed_at: new Date().toISOString()
      };

      await this._audit('delegated_execution_failed', {
        execution_id,
        reason
      });

      return {
        execution_id,
        verified: false,
        state: DELEGATED_STATES.FAILED,
        reason
      };
    }
  }

  /**
   * Get execution by ID with full timeline
   * 
   * @param {string} executionId 
   * @returns {object|null} Execution record
   */
  getExecution(executionId) {
    return this.executions.get(executionId) || null;
  }

  /**
   * Get execution timeline
   * 
   * @param {string} executionId 
   * @returns {Array} Timeline entries
   */
  getTimeline(executionId) {
    const execution = this.executions.get(executionId);
    return execution ? execution.timeline : [];
  }

  /**
   * List all executions with optional filters
   */
  listExecutions(filters = {}) {
    let results = Array.from(this.executions.values());
    
    if (filters.state) {
      results = results.filter(e => e.state === filters.state);
    }
    if (filters.warrant_id) {
      results = results.filter(e => e.warrant_id === filters.warrant_id);
    }
    
    return results.map(e => ({
      execution_id: e.execution_id,
      warrant_id: e.warrant_id,
      state: e.state,
      created_at: e.created_at,
      updated_at: e.updated_at
    }));
  }

  // --- Internal methods ---

  _transition(executionId, newState, detail = {}) {
    const execution = this.executions.get(executionId);
    if (!execution) {
      throw new DelegatedExecutionError('NOT_FOUND', `Execution ${executionId} not found`);
    }

    const valid = VALID_TRANSITIONS[execution.state];
    if (!valid || !valid.includes(newState)) {
      throw new DelegatedExecutionError(
        'INVALID_TRANSITION',
        `Cannot transition from ${execution.state} to ${newState}`
      );
    }

    execution.state = newState;
    execution.updated_at = new Date().toISOString();
    execution.timeline.push({
      state: newState,
      timestamp: new Date().toISOString(),
      ...detail
    });
  }

  _verifyReceipt(receipt, execution) {
    // Stub: accept any receipt for now
    // Future: cryptographic verification (HMAC-SHA256 over execution payload)
    if (!receipt) return true; // no receipt required yet
    if (receipt.hash) return true; // has hash = good enough for now
    return true;
  }

  _startTimeout(executionId, timeoutMs) {
    const timer = setTimeout(() => {
      const execution = this.executions.get(executionId);
      if (execution && ![DELEGATED_STATES.COMPLETE, DELEGATED_STATES.FAILED, DELEGATED_STATES.TIMED_OUT].includes(execution.state)) {
        try {
          this._transition(executionId, DELEGATED_STATES.TIMED_OUT, {
            detail: `Execution timed out after ${timeoutMs}ms`
          });
          this._audit('delegated_execution_timeout', { execution_id: executionId, timeout_ms: timeoutMs });
        } catch (e) {
          // swallow transition errors on timeout
        }
      }
    }, timeoutMs);
    
    this.timeouts.set(executionId, timer);
  }

  _clearTimeout(executionId) {
    const timer = this.timeouts.get(executionId);
    if (timer) {
      clearTimeout(timer);
      this.timeouts.delete(executionId);
    }
  }

  async _httpPost(url, body, headers, timeoutMs) {
    // Use Node's built-in fetch (Node 18+) or fallback
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });
      
      return {
        status: response.status,
        body: await response.json().catch(() => null)
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async _audit(eventType, data) {
    if (this.auditLog) {
      try {
        await this.auditLog.emit({
          event_type: eventType,
          timestamp: new Date().toISOString(),
          ...data
        });
      } catch (e) {
        // Don't fail execution on audit errors
      }
    }
  }

  _generateExecutionId() {
    return `dex_${crypto.randomBytes(12).toString('hex')}`;
  }
}

class DelegatedExecutionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'DelegatedExecutionError';
  }
}

module.exports = { DelegatedExecution, DelegatedExecutionError, DELEGATED_STATES, VALID_TRANSITIONS };
