const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

test('kind integration smoke test', { skip: !process.env.NORTHSTAR_INTEGRATION }, () => {
  const contexts = execFileSync(process.env.NORTHSTAR_KUBECTL || 'kubectl', ['config', 'get-contexts', '-o', 'name'], { encoding: 'utf8' });
  assert.ok(contexts.trim(), 'NORTHSTAR_INTEGRATION requires an accessible kubeconfig context');
});
