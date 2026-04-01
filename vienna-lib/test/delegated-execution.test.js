/**
 * Delegated + Managed Execution Tests
 * 
 * Tests the full round-trip:
 *   1. Warrant → Instruction
 *   2. Dispatch to mock agent
 *   3. Agent callback with result
 *   4. State transitions verified
 *   5. Webhook adapter execution
 */

const http = require('http');
const { DelegatedExecution, DELEGATED_STATES } = require('../execution/delegated-execution');
const { WebhookAdapter } = require('../execution/webhook-adapter');
const { AdapterRegistry } = require('../execution/adapter-registry');
const { ExecutionAPI } = require('../execution/execution-api');

// Simple audit log collector for testing
class TestAuditLog {
  constructor() { this.events = []; }
  async emit(event) { this.events.push(event); }
}

// --- Unit Tests ---

async function testInstructionCreation() {
  console.log('\n📋 Test: Instruction creation from warrant');
  
  const de = new DelegatedExecution();
  
  const warrant = {
    id: 'wrt_test_001',
    objective: 'Transfer $500 to vendor account',
    riskTier: 'T2',
    allowedActions: ['bank_transfer'],
    forbiddenActions: ['crypto_transfer'],
    constraints: { max_amount: 500, currency: 'USD' }
  };

  const instruction = de.createInstruction(warrant, {
    action: 'bank_transfer',
    params: { amount: 500, recipient: 'vendor_acct_123' }
  });

  assert(instruction.execution_id.startsWith('dex_'), 'execution_id prefix');
  assert(instruction.warrant_id === 'wrt_test_001', 'warrant_id');
  assert(instruction.action === 'bank_transfer', 'action');
  assert(instruction.params.amount === 500, 'params');
  assert(instruction.constraints.risk_tier === 'T2', 'risk_tier');
  assert(instruction.callback_url.includes('/api/v1/execution/result'), 'callback_url');
  
  // Check state was recorded
  const execution = de.getExecution(instruction.execution_id);
  assert(execution.state === DELEGATED_STATES.PLANNED, 'initial state is planned');
  assert(execution.timeline.length === 1, 'one timeline entry');
  
  console.log('  ✅ Instruction created, state = planned');
}

async function testStateTransitions() {
  console.log('\n🔄 Test: State machine transitions');
  
  const de = new DelegatedExecution();
  const warrant = { id: 'wrt_test_002', objective: 'test', riskTier: 'T1', allowedActions: ['test'] };
  const instruction = de.createInstruction(warrant);
  const eid = instruction.execution_id;

  // planned → approved (manual transition for testing)
  de._transition(eid, DELEGATED_STATES.APPROVED);
  assert(de.getExecution(eid).state === DELEGATED_STATES.APPROVED, 'approved');

  // approved → dispatched
  de._transition(eid, DELEGATED_STATES.DISPATCHED);
  assert(de.getExecution(eid).state === DELEGATED_STATES.DISPATCHED, 'dispatched');

  // dispatched → executing
  de._transition(eid, DELEGATED_STATES.EXECUTING);
  assert(de.getExecution(eid).state === DELEGATED_STATES.EXECUTING, 'executing');

  // executing → verifying
  de._transition(eid, DELEGATED_STATES.VERIFYING);
  assert(de.getExecution(eid).state === DELEGATED_STATES.VERIFYING, 'verifying');

  // verifying → complete
  de._transition(eid, DELEGATED_STATES.COMPLETE);
  assert(de.getExecution(eid).state === DELEGATED_STATES.COMPLETE, 'complete');

  // complete → anything should fail
  let threw = false;
  try {
    de._transition(eid, DELEGATED_STATES.FAILED);
  } catch (e) {
    threw = true;
    assert(e.code === 'INVALID_TRANSITION', 'correct error code');
  }
  assert(threw, 'invalid transition threw');

  // Check timeline has all entries
  const timeline = de.getTimeline(eid);
  assert(timeline.length === 6, `timeline has 6 entries (got ${timeline.length})`);
  
  console.log('  ✅ All state transitions valid, invalid transitions rejected');
}

async function testAdapterRegistry() {
  console.log('\n📦 Test: Adapter registry');
  
  const registry = new AdapterRegistry();
  
  // Register
  const config = registry.register({
    tenant_id: 'tenant_001',
    type: 'webhook',
    endpoint_url: 'https://api.example.com/execute',
    auth_type: 'bearer',
    encrypted_credentials: { token: 'test_token_123' }
  });

  assert(config.id.startsWith('adc_'), 'id prefix');
  assert(config.tenant_id === 'tenant_001', 'tenant_id');
  assert(config.type === 'webhook', 'type');

  // Get
  const retrieved = registry.get(config.id);
  assert(retrieved.endpoint_url === 'https://api.example.com/execute', 'get works');

  // List by tenant
  const list = registry.listByTenant('tenant_001');
  assert(list.length === 1, 'list returns 1');

  // Update
  registry.update(config.id, { endpoint_url: 'https://api.example.com/v2/execute' });
  assert(registry.get(config.id).endpoint_url === 'https://api.example.com/v2/execute', 'update works');

  // Remove
  assert(registry.remove(config.id) === true, 'remove returns true');
  assert(registry.get(config.id) === null, 'removed');
  assert(registry.listByTenant('tenant_001').length === 0, 'tenant list empty');
  
  console.log('  ✅ Registry CRUD operations working');
}

async function testFullRoundTrip() {
  console.log('\n🔁 Test: Full delegated execution round-trip with mock agent');
  
  const audit = new TestAuditLog();
  
  // Start mock agent server
  const mockAgent = await startMockAgent(9876);
  
  try {
    const de = new DelegatedExecution({ 
      auditLog: audit,
      callbackBaseUrl: 'http://localhost:9877'  // Vienna's callback URL
    });

    // 1. Create instruction from warrant
    const warrant = {
      id: 'wrt_roundtrip_001',
      objective: 'Send notification email',
      riskTier: 'T0',
      allowedActions: ['send_email'],
      constraints: { to: 'test@example.com', subject: 'Hello' }
    };

    const instruction = de.createInstruction(warrant, {
      action: 'send_email',
      params: { to: 'test@example.com', subject: 'Hello', body: 'Test' }
    });

    // 2. Dispatch to mock agent
    const dispatchResult = await de.dispatch(
      instruction.execution_id,
      'http://localhost:9876/execute'
    );

    assert(dispatchResult.success === true, 'dispatch succeeded');
    assert(dispatchResult.state === DELEGATED_STATES.DISPATCHED, 'state is dispatched');

    // 3. Simulate agent callback
    const callbackResult = await de.processResult({
      execution_id: instruction.execution_id,
      status: 'success',
      receipt: { hash: 'abc123def456', message_id: 'msg_001' },
      metadata: { provider: 'sendgrid', delivered: true }
    });

    assert(callbackResult.verified === true, 'result verified');
    assert(callbackResult.state === DELEGATED_STATES.COMPLETE, 'state is complete');

    // 4. Check full timeline
    const execution = de.getExecution(instruction.execution_id);
    assert(execution.state === DELEGATED_STATES.COMPLETE, 'final state complete');
    assert(execution.result.status === 'success', 'result status success');
    assert(execution.timeline.length >= 5, `timeline has ${execution.timeline.length} entries`);

    // 5. Check audit trail
    assert(audit.events.length >= 2, `audit has ${audit.events.length} events`);
    
    console.log(`  ✅ Full round-trip complete. Timeline: ${execution.timeline.length} entries, Audit: ${audit.events.length} events`);
    
  } finally {
    mockAgent.close();
  }
}

async function testWebhookAdapter() {
  console.log('\n🌐 Test: Webhook adapter with mock endpoint');
  
  const audit = new TestAuditLog();
  const mockServer = await startMockWebhook(9878);
  
  try {
    const adapter = new WebhookAdapter({ auditLog: audit, timeoutMs: 5000 });
    
    const adapterConfig = {
      endpoint_url: 'http://localhost:9878/webhook',
      headers: { 'X-Custom': 'test-header' },
      auth_type: 'bearer',
      encrypted_credentials: { token: 'webhook_token_123' }
    };

    const payload = {
      execution_id: 'wex_test_001',
      action: 'deploy_service',
      params: { service: 'api-gateway', version: '2.1.0' }
    };

    const result = await adapter.execute(adapterConfig, payload);

    assert(result.success === true, 'webhook succeeded');
    assert(result.adapter_type === 'webhook', 'adapter type');
    assert(result.receipt.hash, 'has receipt hash');
    assert(result.receipt.http_status === 200, 'http 200');
    assert(result.metadata.attempts === 1, 'single attempt');
    
    console.log(`  ✅ Webhook executed. Receipt: ${result.receipt.hash}, Latency: ${result.metadata.total_latency_ms}ms`);
    
  } finally {
    mockServer.close();
  }
}

async function testWebhookRetry() {
  console.log('\n🔄 Test: Webhook adapter retry on failure');
  
  let requestCount = 0;
  const server = http.createServer((req, res) => {
    requestCount++;
    if (requestCount < 3) {
      res.writeHead(503).end('Service Unavailable');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, attempt: requestCount }));
    }
  });
  
  await new Promise(resolve => server.listen(9879, resolve));
  
  try {
    const adapter = new WebhookAdapter({ timeoutMs: 3000, maxRetries: 2 });
    
    const result = await adapter.execute(
      { endpoint_url: 'http://localhost:9879/retry-test', auth_type: 'none' },
      { execution_id: 'wex_retry_001', action: 'test' }
    );

    assert(result.success === true, 'eventually succeeded');
    assert(result.metadata.attempts === 3, `took 3 attempts (got ${result.metadata.attempts})`);
    
    console.log(`  ✅ Retry logic works. Succeeded on attempt ${result.metadata.attempts}`);
    
  } finally {
    server.close();
  }
}

async function testListExecutions() {
  console.log('\n📑 Test: List and filter executions');
  
  const de = new DelegatedExecution();
  
  // Create multiple executions
  de.createInstruction({ id: 'w1', objective: 'a', riskTier: 'T0', allowedActions: ['x'] });
  de.createInstruction({ id: 'w2', objective: 'b', riskTier: 'T1', allowedActions: ['y'] });
  de.createInstruction({ id: 'w3', objective: 'c', riskTier: 'T2', allowedActions: ['z'] });

  const all = de.listExecutions();
  assert(all.length === 3, 'all 3 listed');

  const byWarrant = de.listExecutions({ warrant_id: 'w2' });
  assert(byWarrant.length === 1, 'filtered by warrant');
  assert(byWarrant[0].warrant_id === 'w2', 'correct warrant');

  console.log('  ✅ Listing and filtering works');
}

// --- Helpers ---

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function startMockAgent(port) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        // Mock agent: acknowledge and return 200
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          acknowledged: true, 
          execution_id: JSON.parse(body).execution_id 
        }));
      });
    });
    server.listen(port, () => resolve(server));
  });
}

function startMockWebhook(port) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          ok: true, 
          received: JSON.parse(body),
          processed_at: new Date().toISOString()
        }));
      });
    });
    server.listen(port, () => resolve(server));
  });
}

// --- Runner ---

async function runAll() {
  console.log('═══════════════════════════════════════════');
  console.log('  Vienna OS — Managed Execution Test Suite');
  console.log('═══════════════════════════════════════════');
  
  const tests = [
    testInstructionCreation,
    testStateTransitions,
    testAdapterRegistry,
    testFullRoundTrip,
    testWebhookAdapter,
    testWebhookRetry,
    testListExecutions
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      await test();
      passed++;
    } catch (error) {
      failed++;
      console.error(`  ❌ FAILED: ${error.message}`);
      console.error(`     ${error.stack?.split('\n')[1]?.trim()}`);
    }
  }

  console.log('\n═══════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════');
  
  process.exit(failed > 0 ? 1 : 0);
}

runAll();
