/**
 * Execution API — HTTP endpoints for delegated + managed execution
 * 
 * Endpoints:
 *   POST /api/v1/execution/dispatch    — Dispatch delegated execution to agent
 *   POST /api/v1/execution/result      — Agent callback with execution result
 *   POST /api/v1/execution/webhook     — Trigger managed webhook execution
 *   GET  /api/v1/execution/:id         — Get execution with full timeline
 *   GET  /api/v1/executions            — List executions (filterable)
 *   POST /api/v1/adapters              — Register adapter config
 *   GET  /api/v1/adapters              — List adapter configs for tenant
 *   DELETE /api/v1/adapters/:id        — Remove adapter config
 */

class ExecutionAPI {
  constructor(options = {}) {
    this.delegatedExecution = options.delegatedExecution;
    this.webhookAdapter = options.webhookAdapter;
    this.adapterRegistry = options.adapterRegistry;
    this.auditLog = options.auditLog || null;
  }

  /**
   * Register routes on an Express-compatible app
   */
  registerRoutes(app) {
    // --- Delegated Execution ---
    
    app.post('/api/v1/execution/dispatch', async (req, res) => {
      try {
        const { warrant, agent_endpoint, auth } = req.body;
        
        if (!warrant || !agent_endpoint) {
          return res.status(400).json({
            error: 'Missing required fields: warrant, agent_endpoint'
          });
        }

        // Create instruction from warrant
        const instruction = this.delegatedExecution.createInstruction(warrant, req.body.options || {});
        
        // Dispatch to agent
        const result = await this.delegatedExecution.dispatch(
          instruction.execution_id,
          agent_endpoint,
          auth || {}
        );

        res.status(result.success ? 202 : 502).json(result);
      } catch (error) {
        res.status(500).json({ error: error.message, code: error.code || 'INTERNAL' });
      }
    });

    app.post('/api/v1/execution/result', async (req, res) => {
      try {
        const { execution_id, status, receipt, metadata } = req.body;
        
        if (!execution_id || !status) {
          return res.status(400).json({
            error: 'Missing required fields: execution_id, status'
          });
        }

        if (!['success', 'failed'].includes(status)) {
          return res.status(400).json({
            error: 'Status must be "success" or "failed"'
          });
        }

        const result = await this.delegatedExecution.processResult({
          execution_id,
          status,
          receipt: receipt || {},
          metadata: metadata || {}
        });

        res.status(200).json(result);
      } catch (error) {
        const status = error.code === 'NOT_FOUND' ? 404 : 
                       error.code === 'INVALID_RESULT' ? 400 : 500;
        res.status(status).json({ error: error.message, code: error.code || 'INTERNAL' });
      }
    });

    // --- Managed (Webhook) Execution ---
    
    app.post('/api/v1/execution/webhook', async (req, res) => {
      try {
        const { adapter_id, execution_payload, warrant } = req.body;
        
        if (!adapter_id && !req.body.adapter_config) {
          return res.status(400).json({
            error: 'Missing adapter_id or inline adapter_config'
          });
        }

        // Get adapter config
        const adapterConfig = adapter_id 
          ? this.adapterRegistry.get(adapter_id)
          : req.body.adapter_config;
        
        if (!adapterConfig) {
          return res.status(404).json({ error: `Adapter ${adapter_id} not found` });
        }

        // Build execution payload
        const payload = execution_payload || {
          execution_id: `wex_${Date.now().toString(36)}`,
          warrant_id: warrant?.id || warrant?.warrant_id,
          action: warrant?.objective || 'webhook_execution',
          params: warrant?.constraints || {},
          issued_at: new Date().toISOString()
        };

        const result = await this.webhookAdapter.execute(adapterConfig, payload);
        
        res.status(result.success ? 200 : 502).json(result);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // --- Execution Query ---
    
    app.get('/api/v1/execution/:id', (req, res) => {
      const execution = this.delegatedExecution.getExecution(req.params.id);
      if (!execution) {
        return res.status(404).json({ error: 'Execution not found' });
      }
      res.json(execution);
    });

    app.get('/api/v1/executions', (req, res) => {
      const filters = {};
      if (req.query.state) filters.state = req.query.state;
      if (req.query.warrant_id) filters.warrant_id = req.query.warrant_id;
      
      const executions = this.delegatedExecution.listExecutions(filters);
      res.json({ executions, count: executions.length });
    });

    // --- Adapter Config Management ---
    
    app.post('/api/v1/adapters', (req, res) => {
      try {
        const config = this.adapterRegistry.register(req.body);
        res.status(201).json(config);
      } catch (error) {
        res.status(400).json({ error: error.message });
      }
    });

    app.get('/api/v1/adapters', (req, res) => {
      const tenantId = req.query.tenant_id || req.headers['x-tenant-id'];
      if (!tenantId) {
        return res.status(400).json({ error: 'tenant_id required' });
      }
      const configs = this.adapterRegistry.listByTenant(tenantId);
      res.json({ adapters: configs, count: configs.length });
    });

    app.delete('/api/v1/adapters/:id', (req, res) => {
      const removed = this.adapterRegistry.remove(req.params.id);
      if (!removed) {
        return res.status(404).json({ error: 'Adapter not found' });
      }
      res.json({ deleted: true, id: req.params.id });
    });
  }
}

module.exports = { ExecutionAPI };
