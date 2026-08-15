const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const port = 5187;
let child;

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

test.after(() => child?.kill('SIGTERM'));

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
});

test('rejects unsafe exec commands', async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/exec`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ namespace: 'northstar', name: 'demo', command: 'echo ok; whoami' }) });
  assert.equal(response.status, 403);
});
