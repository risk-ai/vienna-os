/**
 * ExecutionEngine — Canonical execution authority for Vienna OS
 * 
 * SINGLE SOURCE OF TRUTH for all execution lifecycle:
 *   - State transitions
 *   - Step orchestration
 *   - Adapter dispatch
 *   - Logging + audit
 * 
 * This engine extends the existing QueuedExecutor pipeline by adding
 * three execution tiers as adapter modes, NOT parallel execution paths.
 * 
 * Architecture:
 *   QueuedExecutor (queue, recursion, rate limit, retry, DLQ)
 *     └── Executor (warrant verification, preflight, adapter dispatch)
 *           └── ExecutionEngine (tier routing, step orchestration, gates)
 *                 ├── NativeAdapter — Vienna executes directly (existing adapters)
 *                 ├── DelegatedAdapter — Agent executes, Vienna verifies receipt
 *                 └── ManagedAdapter — Vienna fires customer endpoint (webhook/lambda)
 * 
 * All adapters are STATELESS. They execute a single step and return a result.
 * The engine owns ALL state transitions, timestamps, and step progression.
 * 
 * Integration point: Register this as an adapter type on the existing Executor,
 * or call engine.run() after warrant verification in the QueuedExecutor pipeline.
 */

const crypto = require('crypto');

// --- Canonical States (THE ONLY state machine) ---

const STATE = {
  PLANNED:    'planned',
  APPROVED:   'approved',
  EXECUTING:  'executing',
  VERIFYING:  'verifying',
  COMPLETE:   'complete',
  FAILED:     'failed',
  ROLLED_BACK: 'rolled_back' // stub — not fully implemented yet
};

const VALID_TRANSITIONS = {
  [STATE.PLANNED]:     [STATE.APPROVED, STATE.FAILED],
  [STATE.APPROVED]:    [STATE.EXECUTING, STATE.FAILED],
  [STATE.EXECUTING]:   [STATE.VERIFYING, STATE.FAILED],
  [STATE.VERIFYING]:   [STATE.COMPLETE, STATE.FAILED],
  [STATE.COMPLETE]:    [],
  [STATE.FAILED]:      [],
  [STATE.ROLLED_BACK]: []
};

// --- Execution Tiers ---

const TIER = {
  NATIVE:    'native',     // Vienna executes directly (existing adapters)
  DELEGATED: 'delegated',  // Agent executes, Vienna verifies
  MANAGED:   'managed'     // Vienna fires customer endpoint
};

class ExecutionEngine {
  constructor(options = {}) {
    // Stateless adapters — they ONLY execute, never manage state
    this.adapters = {
      [TIER.NATIVE]:    options.nativeAdapter || null,
      [TIER.DELEGATED]: options.delegatedAdapter || null,
      [TIER.MANAGED]:   options.managedAdapter || null
    };

    // Pre-execution gates (dual-key, etc.) — they block or allow, never own state
    this.gates = options.gates || [];

    // Audit/event sink — engine emits, never reads
    this.auditLog = options.auditLog || null;
    this.eventEmitter = options.eventEmitter || null;

    // Execution store — engine is the ONLY writer
    this.executions = new Map();
  }

  // ──────────────────────────────────────────────
  // PUBLIC API — The only way to interact with execution
  // ──────────────────────────────────────────────

  /**
   * Create an execution from a warrant + steps.
   * Returns an execution record in PLANNED state.
   * 
   * @param {object} warrant - Approved warrant
   * @param {Array<object>} steps - Execution steps
   * @param {object} options - Additional options
   * @returns {object} Execution record
   */
  create(warrant, steps, options = {}) {
    const executionId = this._id();

    const normalizedSteps = steps.map((step, i) => ({
      index: i,
      name: step.name || `Step ${i + 1}`,
      tier: step.tier || TIER.NATIVE,
      action: step.action,
      params: step.params || {},
      depends_on: step.depends_on || [],
      rollback: step.rollback || null,
      // Step-level state (engine-owned, never written by adapters)
      status: 'pending',
      started_at: null,
      completed_at: null,
      latency_ms: null,
      result: null,
      error: null
    }));

    // Validate dependency graph (no cycles)
    this._validateDependencies(normalizedSteps);

    const execution = {
      execution_id: executionId,
      warrant_id: warrant.id || warrant.warrant_id,
      objective: warrant.objective || options.objective || '',
      risk_tier: warrant.riskTier || warrant.risk_tier || 'T1',
      execution_mode: options.execution_mode || 'passthrough',
      state: STATE.PLANNED,
      steps: normalizedSteps,
      timeline: [{
        state: STATE.PLANNED,
        timestamp: new Date().toISOString(),
        detail: 'Execution created'
      }],
      result: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    this.executions.set(executionId, execution);
    this._emit(executionId, 'execution:created', { execution_id: executionId, state: STATE.PLANNED });

    return execution;
  }

  /**
   * Approve an execution for running.
   * Transition: PLANNED → APPROVED
   * 
   * @param {string} executionId 
   * @param {string} approver 
   * @returns {object} Updated execution
   */
  approve(executionId, approver = 'system') {
    const exec = this._getOrThrow(executionId);
    this._transition(exec, STATE.APPROVED, { approver });
    return exec;
  }

  /**
   * Run an execution. This is THE single entry point for all execution.
   * Transition: APPROVED → EXECUTING → VERIFYING → COMPLETE (or FAILED)
   * 
   * Steps are executed in dependency order. Each step is dispatched to
   * its tier's adapter. The engine owns all state transitions.
   * 
   * @param {string} executionId 
   * @returns {Promise<object>} Execution result
   */
  async run(executionId) {
    const exec = this._getOrThrow(executionId);

    // --- Pre-execution gates (dual-key, thresholds, etc.) ---
    for (const gate of this.gates) {
      const gateResult = await gate.check(exec);
      if (gateResult && !gateResult.allowed) {
        this._transition(exec, STATE.FAILED, { detail: `Gate blocked: ${gateResult.reason}` });
        return { execution_id: executionId, state: STATE.FAILED, reason: gateResult.reason };
      }
    }

    // --- Transition to EXECUTING ---
    this._transition(exec, STATE.EXECUTING, { detail: 'Execution started' });

    // --- Execute steps in dependency order ---
    const ordered = this._topologicalSort(exec.steps);
    const completedSteps = [];
    const stepResults = [];

    for (const step of ordered) {
      // Check if dependencies completed
      const depFailed = step.depends_on.some(depIdx => {
        const dep = exec.steps[depIdx];
        return dep.status === 'failed' || dep.status === 'skipped';
      });

      if (depFailed) {
        step.status = 'skipped';
        step.error = 'Dependency failed';
        stepResults.push({ step_index: step.index, status: 'skipped', reason: 'dependency_failed' });
        this._emit(executionId, 'execution:step_skipped', { step_index: step.index, step_name: step.name });
        continue;
      }

      // Execute step via tier adapter
      step.status = 'executing';
      step.started_at = new Date().toISOString();
      this._emit(executionId, 'execution:step_start', { step_index: step.index, step_name: step.name, tier: step.tier });

      try {
        const adapter = this.adapters[step.tier];
        let result;

        if (adapter) {
          // Adapter receives step + execution context, returns result. NOTHING ELSE.
          result = await adapter.execute(step, exec);
        } else {
          // No adapter for this tier — passthrough (existing executor handles it)
          result = { success: true, output: `No adapter for tier "${step.tier}" — passthrough` };
        }

        step.completed_at = new Date().toISOString();
        step.latency_ms = Date.now() - new Date(step.started_at).getTime();
        step.result = result;

        if (result.success) {
          step.status = 'complete';
          completedSteps.push(step);
          stepResults.push({ step_index: step.index, status: 'complete', latency_ms: step.latency_ms });
          this._emit(executionId, 'execution:step_complete', {
            step_index: step.index, step_name: step.name, latency_ms: step.latency_ms
          });
        } else {
          step.status = 'failed';
          step.error = result.error || 'Adapter returned failure';
          stepResults.push({ step_index: step.index, status: 'failed', error: step.error });
          this._emit(executionId, 'execution:step_failed', {
            step_index: step.index, step_name: step.name, error: step.error
          });

          // Fail-fast: stop execution
          this._transition(exec, STATE.FAILED, { detail: `Step "${step.name}" failed: ${step.error}` });
          exec.result = { steps: stepResults, failed_at_step: step.index };
          await this._audit('execution_failed', { execution_id: executionId, failed_step: step.index });
          return { execution_id: executionId, state: STATE.FAILED, results: stepResults };
        }

      } catch (error) {
        step.status = 'failed';
        step.completed_at = new Date().toISOString();
        step.latency_ms = Date.now() - new Date(step.started_at).getTime();
        step.error = error.message;
        stepResults.push({ step_index: step.index, status: 'failed', error: error.message });
        this._emit(executionId, 'execution:step_failed', {
          step_index: step.index, step_name: step.name, error: error.message
        });

        this._transition(exec, STATE.FAILED, { detail: `Step "${step.name}" threw: ${error.message}` });
        exec.result = { steps: stepResults, failed_at_step: step.index };
        await this._audit('execution_failed', { execution_id: executionId, failed_step: step.index, error: error.message });
        return { execution_id: executionId, state: STATE.FAILED, results: stepResults };
      }
    }

    // --- All steps complete → VERIFYING ---
    this._transition(exec, STATE.VERIFYING, { detail: 'All steps complete, verifying' });

    // Verification: check all steps succeeded (defensive)
    const allSuccess = exec.steps.every(s => s.status === 'complete' || s.status === 'skipped');

    if (allSuccess) {
      this._transition(exec, STATE.COMPLETE, { detail: 'Execution verified complete' });
      exec.result = { steps: stepResults };
      await this._audit('execution_complete', { execution_id: executionId, steps: stepResults.length });
      this._emit(executionId, 'execution:complete', { execution_id: executionId });
      return { execution_id: executionId, state: STATE.COMPLETE, results: stepResults };
    } else {
      this._transition(exec, STATE.FAILED, { detail: 'Verification failed: not all steps succeeded' });
      exec.result = { steps: stepResults };
      return { execution_id: executionId, state: STATE.FAILED, results: stepResults };
    }
  }

  /**
   * Get execution by ID (read-only)
   */
  get(executionId) {
    return this.executions.get(executionId) || null;
  }

  /**
   * Get execution timeline
   */
  getTimeline(executionId) {
    const exec = this.executions.get(executionId);
    return exec ? exec.timeline : [];
  }

  /**
   * List executions with optional filters
   */
  list(filters = {}) {
    let results = Array.from(this.executions.values());
    if (filters.state) results = results.filter(e => e.state === filters.state);
    if (filters.warrant_id) results = results.filter(e => e.warrant_id === filters.warrant_id);
    return results.map(e => ({
      execution_id: e.execution_id,
      warrant_id: e.warrant_id,
      state: e.state,
      objective: e.objective,
      steps: e.steps.length,
      created_at: e.created_at,
      updated_at: e.updated_at
    }));
  }

  /**
   * Register or replace an adapter for a tier
   */
  registerAdapter(tier, adapter) {
    if (!Object.values(TIER).includes(tier)) {
      throw new Error(`Invalid tier: ${tier}. Must be one of: ${Object.values(TIER).join(', ')}`);
    }
    this.adapters[tier] = adapter;
  }

  /**
   * Register a pre-execution gate
   * Gates must implement: { check(execution) → { allowed: bool, reason?: string } }
   */
  registerGate(gate) {
    this.gates.push(gate);
  }

  // ──────────────────────────────────────────────
  // INTERNAL — State management (engine-only)
  // ──────────────────────────────────────────────

  _transition(exec, newState, detail = {}) {
    const valid = VALID_TRANSITIONS[exec.state];
    if (!valid || !valid.includes(newState)) {
      throw new EngineError(
        'INVALID_TRANSITION',
        `Cannot transition from ${exec.state} to ${newState}`
      );
    }

    const prevState = exec.state;
    exec.state = newState;
    exec.updated_at = new Date().toISOString();
    exec.timeline.push({
      state: newState,
      timestamp: new Date().toISOString(),
      ...detail
    });

    this._emit(exec.execution_id, 'execution:state_change', {
      from: prevState,
      to: newState,
      ...detail
    });
  }

  _getOrThrow(executionId) {
    const exec = this.executions.get(executionId);
    if (!exec) throw new EngineError('NOT_FOUND', `Execution ${executionId} not found`);
    return exec;
  }

  _validateDependencies(steps) {
    const visited = new Set();
    const visiting = new Set();
    const visit = (idx) => {
      if (visiting.has(idx)) throw new EngineError('CYCLE', `Dependency cycle at step ${idx}`);
      if (visited.has(idx)) return;
      visiting.add(idx);
      for (const dep of steps[idx].depends_on) {
        if (dep < 0 || dep >= steps.length) throw new EngineError('INVALID_DEP', `Step ${idx} depends on non-existent step ${dep}`);
        visit(dep);
      }
      visiting.delete(idx);
      visited.add(idx);
    };
    for (let i = 0; i < steps.length; i++) visit(i);
  }

  _topologicalSort(steps) {
    const sorted = [];
    const visited = new Set();
    const visit = (idx) => {
      if (visited.has(idx)) return;
      visited.add(idx);
      for (const dep of steps[idx].depends_on) visit(dep);
      sorted.push(steps[idx]);
    };
    for (let i = 0; i < steps.length; i++) visit(i);
    return sorted;
  }

  _emit(executionId, eventType, data) {
    if (this.eventEmitter) {
      try {
        // Compatible with ViennaEventEmitter or ExecutionStream
        if (typeof this.eventEmitter.emit === 'function') {
          this.eventEmitter.emit(executionId, eventType, data);
        }
      } catch (e) { /* swallow */ }
    }
  }

  async _audit(eventType, data) {
    if (this.auditLog) {
      try {
        await this.auditLog.emit({ event_type: eventType, timestamp: new Date().toISOString(), ...data });
      } catch (e) { /* swallow */ }
    }
  }

  _id() {
    return `exe_${crypto.randomBytes(10).toString('hex')}`;
  }
}

class EngineError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'EngineError';
  }
}

module.exports = { ExecutionEngine, EngineError, STATE, VALID_TRANSITIONS, TIER };
