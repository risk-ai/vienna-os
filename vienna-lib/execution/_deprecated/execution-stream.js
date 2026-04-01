/**
 * Execution Stream — Server-Sent Events (SSE) for real-time execution progress
 * 
 * Streams live execution events to connected clients.
 * Supports per-execution and per-plan streaming.
 * 
 * Events:
 *   - execution:state_change  — state transition
 *   - execution:step_start    — plan step began
 *   - execution:step_complete — plan step finished
 *   - execution:step_failed   — plan step failed
 *   - execution:plan_complete — full plan finished
 *   - execution:rollback      — rollback triggered
 *   - execution:timeout       — execution timed out
 */

class ExecutionStream {
  constructor(options = {}) {
    this.clients = new Map();      // executionId/planId → Set<response>
    this.globalClients = new Set(); // clients listening to ALL events
    this.eventBuffer = new Map();   // executionId → last N events (replay buffer)
    this.bufferSize = options.bufferSize || 50;
  }

  /**
   * Register SSE routes on Express app
   */
  registerRoutes(app) {
    // Stream events for a specific execution
    app.get('/api/v1/execution/:id/stream', (req, res) => {
      this._initSSE(res);
      const id = req.params.id;
      
      if (!this.clients.has(id)) this.clients.set(id, new Set());
      this.clients.get(id).add(res);

      // Replay buffered events
      const buffer = this.eventBuffer.get(id) || [];
      for (const event of buffer) {
        this._sendEvent(res, event);
      }

      req.on('close', () => {
        this.clients.get(id)?.delete(res);
      });
    });

    // Stream events for a plan (all steps)
    app.get('/api/v1/plan/:id/stream', (req, res) => {
      this._initSSE(res);
      const id = req.params.id;
      
      if (!this.clients.has(id)) this.clients.set(id, new Set());
      this.clients.get(id).add(res);

      const buffer = this.eventBuffer.get(id) || [];
      for (const event of buffer) {
        this._sendEvent(res, event);
      }

      req.on('close', () => {
        this.clients.get(id)?.delete(res);
      });
    });

    // Global execution event stream
    app.get('/api/v1/executions/stream', (req, res) => {
      this._initSSE(res);
      this.globalClients.add(res);

      req.on('close', () => {
        this.globalClients.delete(res);
      });
    });
  }

  /**
   * Emit an execution event to subscribed clients
   * 
   * @param {string} targetId - execution_id or plan_id
   * @param {string} eventType - event name
   * @param {object} data - event payload
   */
  emit(targetId, eventType, data) {
    const event = {
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: eventType,
      data: {
        ...data,
        timestamp: new Date().toISOString()
      }
    };

    // Buffer event
    if (!this.eventBuffer.has(targetId)) this.eventBuffer.set(targetId, []);
    const buffer = this.eventBuffer.get(targetId);
    buffer.push(event);
    if (buffer.length > this.bufferSize) buffer.shift();

    // Send to target-specific clients
    const targetClients = this.clients.get(targetId);
    if (targetClients) {
      for (const client of targetClients) {
        this._sendEvent(client, event);
      }
    }

    // Send to global clients
    for (const client of this.globalClients) {
      this._sendEvent(client, { ...event, data: { ...event.data, target_id: targetId } });
    }
  }

  /**
   * Create plan execution callbacks that auto-stream
   */
  createPlanCallbacks(planId) {
    return {
      onStepStart: (step, plan) => {
        this.emit(planId, 'execution:step_start', {
          plan_id: planId,
          step_index: step.index,
          step_name: step.name,
          tier: step.tier
        });
      },
      onStepComplete: (step, plan) => {
        this.emit(planId, 'execution:step_complete', {
          plan_id: planId,
          step_index: step.index,
          step_name: step.name,
          latency_ms: step.latency_ms,
          result: step.result
        });
      },
      onStepFailed: (step, plan) => {
        this.emit(planId, 'execution:step_failed', {
          plan_id: planId,
          step_index: step.index,
          step_name: step.name,
          error: step.error || step.result?.error
        });
      },
      onPlanComplete: (plan, results, finalStatus) => {
        this.emit(planId, 'execution:plan_complete', {
          plan_id: planId,
          status: finalStatus,
          total_steps: plan.steps.length,
          completed: results.filter(r => r.status === 'complete').length,
          failed: results.filter(r => r.status === 'failed').length,
          rolled_back: finalStatus === 'rolled_back'
        });
      }
    };
  }

  /**
   * Emit state change for delegated execution
   */
  emitStateChange(executionId, fromState, toState, detail = {}) {
    this.emit(executionId, 'execution:state_change', {
      execution_id: executionId,
      from: fromState,
      to: toState,
      ...detail
    });
  }

  /**
   * Get connected client count
   */
  getStats() {
    let targeted = 0;
    for (const set of this.clients.values()) targeted += set.size;
    return {
      targeted_connections: targeted,
      global_connections: this.globalClients.size,
      buffered_targets: this.eventBuffer.size
    };
  }

  // --- Internal ---

  _initSSE(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(':ok\n\n');
  }

  _sendEvent(res, event) {
    try {
      res.write(`id: ${event.id}\n`);
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event.data)}\n\n`);
    } catch (e) {
      // Client disconnected
    }
  }
}

module.exports = { ExecutionStream };
