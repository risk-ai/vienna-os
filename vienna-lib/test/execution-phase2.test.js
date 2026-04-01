/**
 * Phase 2 Tests — Execution Plans, Workflows, Rollback, SSE, Dual-Key
 */

const http = require('http');
const { ExecutionPlan, STEP_STATUS, EXECUTION_TIERS } = require('../execution/execution-plan');
const { ExecutionStream } = require('../execution/execution-stream');
const { DualKeyGate, CONFIRMATION_TYPES } = require('../execution/dual-key');
const { LambdaAdapter } = require('../execution/lambda-adapter');

class TestAuditLog {
  constructor() { this.events = []; }
  async emit(event) { this.events.push(event); }
}

// --- Tests ---

async function testPlanGeneration() {
  console.log('\n📋 Test: Execution plan generation');

  const planner = new ExecutionPlan();

  const warrant = {
    id: 'wrt_plan_001',
    objective: 'Deploy new API version and notify team',
    riskTier: 'T1',
    allowedActions: ['deploy', 'notify']
  };

  const steps = [
    {
      name: 'Validate deployment artifact',
      description: 'Check Docker image exists and passes security scan',
      tier: EXECUTION_TIERS.NATIVE,
      action: 'validate_artifact',
      params: { image: 'api:2.1.0' },
      risk_level: 'low'
    },
    {
      name: 'Deploy to staging',
      description: 'Deploy via webhook to K8s staging cluster',
      tier: EXECUTION_TIERS.MANAGED,
      action: 'deploy',
      params: { env: 'staging', image: 'api:2.1.0' },
      depends_on: [0],
      rollback: { action: 'deploy', params: { env: 'staging', image: 'api:2.0.0' } },
      risk_level: 'medium'
    },
    {
      name: 'Run smoke tests',
      description: 'Hit health endpoints on staging',
      tier: EXECUTION_TIERS.NATIVE,
      action: 'smoke_test',
      params: { url: 'https://staging.api.com/health' },
      depends_on: [1],
      risk_level: 'low'
    },
    {
      name: 'Deploy to production',
      description: 'Agent deploys to production K8s cluster',
      tier: EXECUTION_TIERS.DELEGATED,
      action: 'deploy',
      params: { env: 'production', image: 'api:2.1.0' },
      depends_on: [2],
      rollback: { action: 'deploy', params: { env: 'production', image: 'api:2.0.0' } },
      risk_level: 'high'
    },
    {
      name: 'Notify team',
      description: 'Send Slack notification',
      tier: EXECUTION_TIERS.NATIVE,
      action: 'notify',
      params: { channel: '#deployments', message: 'API 2.1.0 deployed' },
      depends_on: [3]
    }
  ];

  const plan = planner.generate(warrant, steps);

  assert(plan.plan_id.startsWith('plan_'), 'plan ID');
  assert(plan.steps.length === 5, '5 steps');
  assert(plan.rollback_available === true, 'rollback available');
  assert(plan.status === 'draft', 'draft status');
  assert(plan.summary.includes('Deploy to staging'), 'summary includes step names');
  assert(plan.steps[1].depends_on.includes(0), 'dependency preserved');
  assert(plan.steps[3].rollback !== null, 'rollback on step 3');

  console.log('  ✅ Plan generated with 5 steps, dependencies, and rollbacks');
}

async function testPlanExecution() {
  console.log('\n▶️  Test: Plan execution with step callbacks');

  const planner = new ExecutionPlan();
  const events = [];

  const plan = planner.generate(
    { id: 'w1', objective: 'Test workflow', riskTier: 'T0', allowedActions: ['test'] },
    [
      { name: 'Step A', tier: 'native', action: 'a' },
      { name: 'Step B', tier: 'managed', action: 'b', depends_on: [0] },
      { name: 'Step C', tier: 'native', action: 'c', depends_on: [1] }
    ]
  );

  planner.approve(plan.plan_id, 'test_user');

  const executors = {
    native: async (step) => { events.push(`native:${step.name}`); return { success: true, output: `${step.name} done` }; },
    managed: async (step) => { events.push(`managed:${step.name}`); return { success: true, output: `${step.name} done` }; }
  };

  const result = await planner.execute(plan.plan_id, executors, {
    onStepStart: (step) => events.push(`start:${step.name}`),
    onStepComplete: (step) => events.push(`complete:${step.name}`)
  });

  assert(result.status === 'complete', 'plan completed');
  assert(result.results.length === 3, '3 results');
  assert(events.includes('native:Step A'), 'Step A executed as native');
  assert(events.includes('managed:Step B'), 'Step B executed as managed');
  assert(events.indexOf('native:Step A') < events.indexOf('managed:Step B'), 'A before B');

  console.log(`  ✅ Plan executed in order. Events: ${events.length}`);
}

async function testRollbackOnFailure() {
  console.log('\n↩️  Test: Rollback on step failure');

  const planner = new ExecutionPlan();
  const rollbackLog = [];

  const plan = planner.generate(
    { id: 'w2', objective: 'Fail test', riskTier: 'T1', allowedActions: ['test'] },
    [
      { name: 'Step 1', tier: 'native', action: 'a', rollback: { action: 'undo_a' } },
      { name: 'Step 2', tier: 'native', action: 'b', rollback: { action: 'undo_b' } },
      { name: 'Step 3 (fails)', tier: 'native', action: 'c', depends_on: [0, 1] }
    ]
  );

  planner.approve(plan.plan_id, 'test');

  const executors = {
    native: async (step) => {
      if (step.is_rollback) {
        rollbackLog.push(`rollback:${step.name}`);
        return { success: true };
      }
      if (step.action === 'c') return { success: false, error: 'Simulated failure' };
      return { success: true, output: 'ok' };
    }
  };

  const result = await planner.execute(plan.plan_id, executors);

  assert(result.status === 'rolled_back', 'plan rolled back');
  assert(rollbackLog.length >= 1, 'at least 1 rollback executed');

  const finalPlan = planner.getPlan(plan.plan_id);
  assert(finalPlan.status === 'rolled_back', 'final status is rolled_back');

  console.log(`  ✅ Failure at step 3 triggered rollback. Rolled back ${rollbackLog.length} steps`);
}

async function testDependencySkip() {
  console.log('\n⏭️  Test: Skip steps when dependency fails');

  const planner = new ExecutionPlan();

  const plan = planner.generate(
    { id: 'w3', objective: 'Dep test', riskTier: 'T0', allowedActions: ['t'] },
    [
      { name: 'Fails', tier: 'native', action: 'fail', fail_fast: false },
      { name: 'Depends on fail', tier: 'native', action: 'b', depends_on: [0] },
      { name: 'Independent', tier: 'native', action: 'c' }
    ]
  );

  planner.approve(plan.plan_id, 'test');

  const result = await planner.execute(plan.plan_id, {
    native: async (step) => {
      if (step.action === 'fail') return { success: false, error: 'nope' };
      return { success: true };
    }
  });

  // Step 1 fails (fail_fast: false), step 2 skipped (dependency), step 3 runs
  assert(result.results[1].status === 'skipped', 'step 2 skipped');
  assert(result.results[2].status === 'complete', 'step 3 completed (independent)');

  console.log('  ✅ Dependent step skipped, independent step executed');
}

async function testDualKeyOTP() {
  console.log('\n🔐 Test: Dual-key OTP confirmation');

  const audit = new TestAuditLog();
  let sentOTP = null;

  const gate = new DualKeyGate({
    auditLog: audit,
    thresholds: { dollar_amount: 1000, risk_tier: 'T2' },
    otpExpiryMs: 5000,
    notifier: {
      sendOTP: async (recipient, otp) => { sentOTP = otp; }
    }
  });

  // Check threshold
  assert(gate.requiresConfirmation({ params: { amount: 5000 } }) === true, 'requires for $5K');
  assert(gate.requiresConfirmation({ params: { amount: 500 } }) === false, 'not required for $500');
  assert(gate.requiresConfirmation({ risk_tier: 'T2' }) === true, 'requires for T2');

  // Request OTP
  const req = await gate.requestConfirmation('exec_001', CONFIRMATION_TYPES.OTP, {
    recipient: 'user@example.com'
  });

  assert(req.status === 'pending', 'pending');
  assert(sentOTP !== null, 'OTP sent via notifier');

  // Verify wrong code
  const badResult = await gate.verifyOTP(req.confirmation_id, '000000');
  assert(badResult.verified === false, 'wrong code rejected');

  // Verify correct code
  const goodResult = await gate.verifyOTP(req.confirmation_id, sentOTP);
  assert(goodResult.verified === true, 'correct code accepted');
  assert(goodResult.execution_id === 'exec_001', 'execution ID matches');

  // Check fully confirmed
  const status = gate.isFullyConfirmed('exec_001');
  assert(status.confirmed === true, 'fully confirmed');

  console.log(`  ✅ OTP flow complete. Audit events: ${audit.events.length}`);
}

async function testDualKeySupervisor() {
  console.log('\n👤 Test: Dual-key supervisor sign-off');

  let notified = false;
  const gate = new DualKeyGate({
    notifier: {
      notifySupervisor: async () => { notified = true; }
    }
  });

  const req = await gate.requestConfirmation('exec_002', CONFIRMATION_TYPES.SUPERVISOR, {
    supervisor_id: 'supervisor_alice',
    reason: '$75K wire transfer requires approval'
  });

  assert(notified, 'supervisor notified');
  assert(req.status === 'pending', 'pending');

  // Supervisor approves
  const decision = await gate.supervisorDecision(req.confirmation_id, 'supervisor_alice', true);
  assert(decision.verified === true, 'approved');
  assert(decision.decided_by === 'supervisor_alice', 'correct supervisor');

  // Test denial flow
  const req2 = await gate.requestConfirmation('exec_003', CONFIRMATION_TYPES.SUPERVISOR, {
    supervisor_id: 'supervisor_bob'
  });
  const denial = await gate.supervisorDecision(req2.confirmation_id, 'supervisor_bob', false);
  assert(denial.verified === false, 'denied');

  console.log('  ✅ Supervisor approval and denial flows working');
}

async function testSSEStream() {
  console.log('\n📡 Test: SSE execution stream');

  const stream = new ExecutionStream();
  const receivedEvents = [];

  // Create a mock Express app
  const app = {
    routes: {},
    get(path, handler) { this.routes[path] = handler; }
  };

  stream.registerRoutes(app);
  assert(Object.keys(app.routes).length === 3, '3 SSE routes registered');

  // Test event emission and buffering
  stream.emit('exec_123', 'execution:state_change', { from: 'planned', to: 'approved' });
  stream.emit('exec_123', 'execution:state_change', { from: 'approved', to: 'dispatched' });
  stream.emit('exec_123', 'execution:step_start', { step: 0, name: 'Deploy' });

  const stats = stream.getStats();
  assert(stats.buffered_targets === 1, '1 target buffered');

  // Test plan callbacks factory
  const callbacks = stream.createPlanCallbacks('plan_456');
  assert(typeof callbacks.onStepStart === 'function', 'onStepStart callback');
  assert(typeof callbacks.onPlanComplete === 'function', 'onPlanComplete callback');

  // Trigger callbacks
  callbacks.onStepStart({ index: 0, name: 'Test', tier: 'native' }, {});
  callbacks.onStepComplete({ index: 0, name: 'Test', latency_ms: 42, result: { ok: true } }, {});
  callbacks.onPlanComplete(
    { steps: [{}, {}] },
    [{ status: 'complete' }, { status: 'complete' }],
    'complete'
  );

  const stats2 = stream.getStats();
  assert(stats2.buffered_targets === 2, '2 targets buffered (exec + plan)');

  console.log('  ✅ SSE routes registered, events buffered, plan callbacks wired');
}

async function testLambdaAdapter() {
  console.log('\n⚡ Test: Lambda adapter with mock function');

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const parsed = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        statusCode: 200,
        result: `Processed ${parsed.action}`,
        function_name: 'test-function'
      }));
    });
  });

  await new Promise(r => server.listen(9880, r));

  try {
    const adapter = new LambdaAdapter({ timeoutMs: 5000 });

    const result = await adapter.execute(
      {
        endpoint_url: 'http://localhost:9880/invoke',
        provider: 'http',
        auth_type: 'none'
      },
      {
        execution_id: 'lex_test_001',
        action: 'process_data',
        params: { dataset: 'users', filter: 'active' }
      }
    );

    assert(result.success === true, 'lambda succeeded');
    assert(result.adapter_type === 'lambda', 'correct type');
    assert(result.receipt.hash, 'has receipt hash');
    assert(result.metadata.provider === 'http', 'detected provider');

    console.log(`  ✅ Lambda adapter executed. Latency: ${result.metadata.total_latency_ms}ms`);
  } finally {
    server.close();
  }
}

async function testCyclicDependencyRejection() {
  console.log('\n🔄 Test: Reject cyclic dependencies');

  const planner = new ExecutionPlan();
  let threw = false;

  try {
    planner.generate(
      { id: 'w_cycle', objective: 'Cycle', riskTier: 'T0', allowedActions: ['t'] },
      [
        { name: 'A', depends_on: [2] },
        { name: 'B', depends_on: [0] },
        { name: 'C', depends_on: [1] }
      ]
    );
  } catch (e) {
    threw = true;
    assert(e.code === 'CYCLE', 'cycle detected');
  }

  assert(threw, 'cyclic dependency rejected');
  console.log('  ✅ Cyclic dependencies correctly rejected');
}

// --- Runner ---

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function runAll() {
  console.log('═══════════════════════════════════════════════');
  console.log('  Vienna OS — Phase 2: Workflows + Execution');
  console.log('═══════════════════════════════════════════════');

  const tests = [
    testPlanGeneration,
    testPlanExecution,
    testRollbackOnFailure,
    testDependencySkip,
    testDualKeyOTP,
    testDualKeySupervisor,
    testSSEStream,
    testLambdaAdapter,
    testCyclicDependencyRejection
  ];

  let passed = 0, failed = 0;

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

  console.log('\n═══════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════');

  process.exit(failed > 0 ? 1 : 0);
}

runAll();
