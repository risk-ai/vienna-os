/**
 * Execution Plan Generator
 * 
 * Before any action runs, Vienna generates a human-readable execution plan.
 * Plans are reviewable, approvable, and auditable. Each step has a type,
 * description, estimated risk, and rollback feasibility.
 * 
 * Plans support:
 *   - Multi-step sequencing across execution tiers
 *   - Pre-computed rollback blueprints for reversible steps
 *   - Dependency ordering between steps
 *   - Human/supervisor review gates
 */

const crypto = require('crypto');

const STEP_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  EXECUTING: 'executing',
  COMPLETE: 'complete',
  FAILED: 'failed',
  ROLLED_BACK: 'rolled_back',
  SKIPPED: 'skipped'
};

const EXECUTION_TIERS = {
  NATIVE: 'native',        // Vienna executes directly
  DELEGATED: 'delegated',  // Agent executes, Vienna verifies
  MANAGED: 'managed'       // Vienna fires customer endpoint
};

class ExecutionPlan {
  constructor(options = {}) {
    this.plans = new Map();
    this.auditLog = options.auditLog || null;
  }

  /**
   * Generate an execution plan from a warrant
   * 
   * @param {object} warrant - Approved warrant
   * @param {Array} steps - Step definitions
   * @param {object} options - Plan options
   * @returns {object} Generated plan
   */
  generate(warrant, steps, options = {}) {
    const planId = `plan_${crypto.randomBytes(8).toString('hex')}`;
    
    const plan = {
      plan_id: planId,
      warrant_id: warrant.id || warrant.warrant_id,
      objective: warrant.objective || options.objective || 'Unnamed objective',
      risk_tier: warrant.riskTier || warrant.risk_tier || 'T1',
      status: 'draft',
      requires_approval: options.requiresApproval ?? (warrant.riskTier === 'T2' || warrant.risk_tier === 'T2'),
      steps: steps.map((step, index) => this._normalizeStep(step, index)),
      rollback_available: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      approved_at: null,
      approved_by: null,
      execution_started_at: null,
      completed_at: null,
      metadata: options.metadata || {}
    };

    // Compute rollback availability
    plan.rollback_available = plan.steps.some(s => s.rollback !== null);

    // Build dependency graph (validate no cycles)
    this._validateDependencies(plan.steps);

    this.plans.set(planId, plan);
    return this._toHumanReadable(plan);
  }

  /**
   * Approve a plan for execution
   */
  approve(planId, approver) {
    const plan = this.plans.get(planId);
    if (!plan) throw new PlanError('NOT_FOUND', `Plan ${planId} not found`);
    if (plan.status !== 'draft') throw new PlanError('INVALID_STATE', `Plan is ${plan.status}, not draft`);

    plan.status = 'approved';
    plan.approved_at = new Date().toISOString();
    plan.approved_by = approver || 'system';
    plan.steps.forEach(s => { if (s.status === STEP_STATUS.PENDING) s.status = STEP_STATUS.APPROVED; });
    plan.updated_at = new Date().toISOString();

    return plan;
  }

  /**
   * Execute a plan step by step
   * 
   * @param {string} planId 
   * @param {object} executors - { native, delegated, managed } executor instances
   * @param {object} callbacks - { onStepStart, onStepComplete, onStepFailed, onPlanComplete }
   * @returns {Promise<object>} Execution results
   */
  async execute(planId, executors = {}, callbacks = {}) {
    const plan = this.plans.get(planId);
    if (!plan) throw new PlanError('NOT_FOUND', `Plan ${planId} not found`);
    if (plan.status !== 'approved') throw new PlanError('NOT_APPROVED', 'Plan must be approved before execution');

    plan.status = 'executing';
    plan.execution_started_at = new Date().toISOString();
    plan.updated_at = new Date().toISOString();

    const results = [];
    const completedSteps = [];

    // Execute steps in dependency order
    const ordered = this._topologicalSort(plan.steps);

    for (const step of ordered) {
      // Check if dependencies completed
      if (step.depends_on.length > 0) {
        const depsFailed = step.depends_on.some(depIdx => {
          const dep = plan.steps[depIdx];
          return dep.status === STEP_STATUS.FAILED || dep.status === STEP_STATUS.ROLLED_BACK;
        });
        if (depsFailed) {
          step.status = STEP_STATUS.SKIPPED;
          step.skip_reason = 'Dependency failed';
          results.push({ step_index: step.index, status: 'skipped', reason: 'dependency_failed' });
          continue;
        }
      }

      step.status = STEP_STATUS.EXECUTING;
      step.started_at = new Date().toISOString();
      if (callbacks.onStepStart) callbacks.onStepStart(step, plan);

      try {
        const executor = executors[step.tier];
        let stepResult;

        if (executor) {
          stepResult = await executor(step);
        } else {
          // No executor for this tier — mark as passthrough
          stepResult = { success: true, output: 'No executor registered — passthrough', tier: step.tier };
        }

        step.status = stepResult.success ? STEP_STATUS.COMPLETE : STEP_STATUS.FAILED;
        step.completed_at = new Date().toISOString();
        step.result = stepResult;
        step.latency_ms = Date.now() - new Date(step.started_at).getTime();

        results.push({
          step_index: step.index,
          status: step.status,
          latency_ms: step.latency_ms,
          result: stepResult
        });

        if (stepResult.success) {
          completedSteps.push(step);
          if (callbacks.onStepComplete) callbacks.onStepComplete(step, plan);
        } else {
          if (callbacks.onStepFailed) callbacks.onStepFailed(step, plan);
          
          // Fail-fast: rollback completed steps if configured
          if (step.fail_fast !== false) {
            await this._rollbackSteps(completedSteps.reverse(), executors, plan);
            plan.status = 'rolled_back';
            plan.completed_at = new Date().toISOString();
            plan.updated_at = new Date().toISOString();
            
            if (callbacks.onPlanComplete) callbacks.onPlanComplete(plan, results, 'rolled_back');
            
            return { plan_id: planId, status: 'rolled_back', results };
          }
        }

      } catch (error) {
        step.status = STEP_STATUS.FAILED;
        step.completed_at = new Date().toISOString();
        step.error = error.message;
        step.latency_ms = Date.now() - new Date(step.started_at).getTime();

        results.push({ step_index: step.index, status: 'failed', error: error.message });

        if (callbacks.onStepFailed) callbacks.onStepFailed(step, plan);

        // Rollback on exception
        await this._rollbackSteps(completedSteps.reverse(), executors, plan);
        plan.status = 'rolled_back';
        plan.completed_at = new Date().toISOString();
        plan.updated_at = new Date().toISOString();

        return { plan_id: planId, status: 'rolled_back', results, error: error.message };
      }
    }

    plan.status = 'complete';
    plan.completed_at = new Date().toISOString();
    plan.updated_at = new Date().toISOString();

    if (callbacks.onPlanComplete) callbacks.onPlanComplete(plan, results, 'complete');

    return { plan_id: planId, status: 'complete', results };
  }

  /**
   * Get plan by ID
   */
  getPlan(planId) {
    return this.plans.get(planId) || null;
  }

  /**
   * Get human-readable summary of a plan
   */
  getSummary(planId) {
    const plan = this.plans.get(planId);
    if (!plan) return null;
    return this._toHumanReadable(plan);
  }

  // --- Rollback Engine ---

  async _rollbackSteps(steps, executors, plan) {
    for (const step of steps) {
      if (!step.rollback || step.status !== STEP_STATUS.COMPLETE) continue;

      try {
        const executor = executors[step.tier];
        if (executor) {
          await executor({
            ...step.rollback,
            index: step.index,
            tier: step.tier,
            is_rollback: true
          });
        }
        step.status = STEP_STATUS.ROLLED_BACK;
        step.rolled_back_at = new Date().toISOString();
      } catch (rollbackError) {
        // Log but don't fail — rollback is best-effort
        step.rollback_error = rollbackError.message;
        await this._audit('rollback_failed', {
          plan_id: plan.plan_id,
          step_index: step.index,
          error: rollbackError.message
        });
      }
    }
  }

  // --- Internal ---

  _normalizeStep(step, index) {
    return {
      index,
      name: step.name || `Step ${index + 1}`,
      description: step.description || '',
      tier: step.tier || EXECUTION_TIERS.NATIVE,
      action: step.action || null,
      params: step.params || {},
      constraints: step.constraints || {},
      depends_on: step.depends_on || [],
      rollback: step.rollback || null,
      fail_fast: step.fail_fast !== false,
      estimated_duration_ms: step.estimated_duration_ms || null,
      risk_level: step.risk_level || 'low',
      status: STEP_STATUS.PENDING,
      started_at: null,
      completed_at: null,
      result: null,
      latency_ms: null,
      error: null
    };
  }

  _validateDependencies(steps) {
    // Check for cycles via DFS
    const visited = new Set();
    const visiting = new Set();

    const visit = (idx) => {
      if (visiting.has(idx)) throw new PlanError('CYCLE', `Dependency cycle detected at step ${idx}`);
      if (visited.has(idx)) return;
      visiting.add(idx);
      const step = steps[idx];
      for (const dep of step.depends_on) {
        if (dep < 0 || dep >= steps.length) throw new PlanError('INVALID_DEP', `Step ${idx} depends on non-existent step ${dep}`);
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

  _toHumanReadable(plan) {
    const lines = [
      `📋 Execution Plan: ${plan.plan_id}`,
      `Objective: ${plan.objective}`,
      `Risk Tier: ${plan.risk_tier} | Requires Approval: ${plan.requires_approval ? 'YES' : 'no'}`,
      `Rollback Available: ${plan.rollback_available ? 'YES' : 'no'}`,
      `Status: ${plan.status}`,
      '',
      'Steps:'
    ];

    for (const step of plan.steps) {
      const status = step.status === 'complete' ? '✅' : step.status === 'failed' ? '❌' : step.status === 'executing' ? '🔄' : '⬜';
      const rollback = step.rollback ? ' [↩️ rollback available]' : '';
      const deps = step.depends_on.length > 0 ? ` (after step ${step.depends_on.join(', ')})` : '';
      lines.push(`  ${status} ${step.index + 1}. [${step.tier.toUpperCase()}] ${step.name}${deps}${rollback}`);
      if (step.description) lines.push(`     ${step.description}`);
    }

    return {
      ...plan,
      summary: lines.join('\n')
    };
  }

  async _audit(eventType, data) {
    if (this.auditLog) {
      try {
        await this.auditLog.emit({ event_type: eventType, timestamp: new Date().toISOString(), ...data });
      } catch (e) { /* swallow */ }
    }
  }
}

class PlanError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'PlanError';
  }
}

module.exports = { ExecutionPlan, PlanError, STEP_STATUS, EXECUTION_TIERS };
