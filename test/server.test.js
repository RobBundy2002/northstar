const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const port = 5187;
let child;
let productionChild;

test.before(async () => {
  child = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(port), NORTHSTAR_MODE: 'simulated', NORTHSTAR_READ_ONLY: 'true', NORTHSTAR_DATA_DIR: '/tmp/northstar-test-data' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 30; i += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/config`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Northstar test server did not start');
});

test.after(() => { child?.kill('SIGTERM'); productionChild?.kill('SIGTERM'); });

test('reports safe simulated configuration', async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/config`);
  assert.deepEqual(await response.json(), { readOnly: true, mode: 'simulated', defaultContext: 'production-east', prometheusConfigured: false });
});

test('serves multi-cluster summaries', async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/multicluster`);
  const clusters = await response.json();
  assert.equal(response.status, 200);
  assert.equal(clusters.length, 3);
  assert.ok(clusters.every(cluster => typeof cluster.health === 'number'));
});

test('blocks mutating actions in read-only mode', async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/actions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'delete', namespace: 'northstar', name: 'demo' }) });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).readOnly, true);
  const podResponse = await fetch(`http://127.0.0.1:${port}/api/pods?context=production-east`);
  assert.ok((await podResponse.json()).some(pod => pod.name === 'payments-api-7d88c96bbf-jk4m2'));
  const auditResponse = await fetch(`http://127.0.0.1:${port}/api/audit`);
  const audit = await auditResponse.json();
  assert.ok(audit.some(entry => entry.action === 'delete' && entry.outcome === 'denied' && entry.reason === 'read-only'));
});

test('rejects unsafe exec commands', async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/exec`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ namespace: 'northstar', name: 'demo', command: 'echo ok; whoami' }) });
  assert.equal(response.status, 403);
});

test('requires confirmation before production mutations', async () => {
  const productionPort = 5188;
  productionChild = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(productionPort), NORTHSTAR_MODE: 'simulated', NORTHSTAR_READ_ONLY: 'false', NORTHSTAR_DATA_DIR: '/tmp/northstar-production-test-data' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 30; i += 1) {
    try { if ((await fetch(`http://127.0.0.1:${productionPort}/api/config`)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const response = await fetch(`http://127.0.0.1:${productionPort}/api/actions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'delete', context: 'production-east', namespace: 'northstar', name: 'demo', kind: 'pod' }) });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).productionGuard, true);
  const audit = await (await fetch(`http://127.0.0.1:${productionPort}/api/audit`)).json();
  assert.ok(audit.some(entry => entry.reason === 'production-confirmation-required'));
});
