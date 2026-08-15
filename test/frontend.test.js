const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync('index.html', 'utf8');

test('frontend exposes the core cockpit views', () => {
  for (const view of ['overview', 'clusters', 'resources', 'workloads', 'nodes', 'events', 'dashboards']) {
    assert.match(html, new RegExp(`id="view-${view}"`));
  }
});

test('frontend keeps destructive controls wired to the API boundary', () => {
  assert.match(html, /\/api\/actions/);
  assert.match(html, /\/api\/exec/);
  assert.match(html, /state\.readOnly/);
});
