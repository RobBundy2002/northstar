const test = require('node:test');
const assert = require('node:assert/strict');
const { validResourcePart, validApiResource, validExecCommand } = require('../lib/validation');

test('validates Kubernetes resource names', () => {
  assert.equal(validResourcePart('payments-api-7d9'), true);
  assert.equal(validResourcePart('../secrets'), false);
  assert.equal(validResourcePart(''), false);
});

test('validates API resource selectors', () => {
  assert.equal(validApiResource('deployments.apps'), true);
  assert.equal(validApiResource('pods;delete'), false);
});

test('allows simple exec commands but rejects shell escape operators', () => {
  assert.equal(validExecCommand('echo northstar'), true);
  assert.equal(validExecCommand('cat /etc/hosts && whoami'), false);
  assert.equal(validExecCommand(''), false);
});
