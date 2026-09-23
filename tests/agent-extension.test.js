'use strict';

// The agent extension is an ESM module loaded by the sidecar's jiti, so a CJS
// test reaches it through a dynamic import. That also keeps the module the
// single source of truth: no duplicated rule text to drift.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE_PATH = path.join(__dirname, '..', 'extensions', 'workflow-rule.mjs');
// Windows rejects a bare absolute path in `import()`; it needs a file:// URL.
const MODULE_URL = pathToFileURL(MODULE_PATH).href;
const SOURCE = fs.readFileSync(MODULE_PATH, 'utf8');

async function load() {
  return import(MODULE_URL);
}

test('the module stays dependency-free', () => {
  // The plugin's read-only thesis has to hold at the code level too: a module
  // running inside the agent process must not reach for fs, network or imports.
  assert.doesNotMatch(SOURCE, /\brequire\s*\(/, 'no require()');
  assert.doesNotMatch(SOURCE, /\bimport\s+[^(]/, 'no static import');
  assert.doesNotMatch(SOURCE, /\bfrom\s+['"]/, 'no module specifier');
  assert.doesNotMatch(SOURCE, /\bfetch\s*\(/, 'no fetch');
  assert.doesNotMatch(SOURCE, /node:fs|node:child_process|node:net/, 'no node builtin');
  assert.doesNotMatch(SOURCE, /Date\.now|Math\.random/, 'no clock or randomness');
});

test('appends the rule to an empty prompt', async () => {
  const { applyStandingRule, buildStandingRule } = await load();
  const result = applyStandingRule({ systemPrompt: '' });
  assert.equal(result.systemPrompt, buildStandingRule());
});

test('preserves the prompt it was handed', async () => {
  const { applyStandingRule } = await load();
  const base = 'You are a helpful agent.\n\n# Skills\n- `a` — b';
  const result = applyStandingRule({ systemPrompt: base });
  assert.ok(result.systemPrompt.startsWith(base), 'the base prompt is carried through, not replaced');
  assert.ok(result.systemPrompt.length > base.length, 'the rule is appended');
});

test('appending is idempotent', async () => {
  const { applyStandingRule } = await load();
  const once = applyStandingRule({ systemPrompt: 'base prompt' }).systemPrompt;
  const twice = applyStandingRule({ systemPrompt: once }).systemPrompt;
  assert.equal(twice, once, 'a second pass must not stack the rule');
});

test('a missing or malformed systemPrompt degrades to the rule alone', async () => {
  const { applyStandingRule, buildStandingRule } = await load();
  assert.equal(applyStandingRule({}).systemPrompt, buildStandingRule());
  assert.equal(applyStandingRule({ systemPrompt: 42 }).systemPrompt, buildStandingRule());
  assert.equal(applyStandingRule(null).systemPrompt, buildStandingRule());
  assert.equal(applyStandingRule(undefined).systemPrompt, buildStandingRule());
});

test('the rule is deterministic', async () => {
  const { buildStandingRule } = await load();
  assert.equal(buildStandingRule(), buildStandingRule());
});

test('the rule names the router skill and the artifact expectation', async () => {
  const { buildStandingRule } = await load();
  const rule = buildStandingRule();
  assert.match(rule, /Architecture Explore/, 'names the skill the model must load');
  assert.match(rule, /first artifact/, 'states the same-turn deliverable');
  assert.match(rule, /directory listing|package manifests/, 'forbids the shallow answer');
});

test('the entry registers exactly one before_agent_start handler', async () => {
  const { default: workflowRule, applyStandingRule } = await load();
  const calls = [];
  const fakePi = { on: (event, handler) => { calls.push({ event, handler }); return () => {}; } };

  workflowRule(fakePi);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].event, 'before_agent_start');
  assert.deepEqual(calls[0].handler({ systemPrompt: 'x' }), applyStandingRule({ systemPrompt: 'x' }));
});

test('the entry is a no-op on a host without on()', async () => {
  const { default: workflowRule } = await load();
  assert.doesNotThrow(() => workflowRule({}));
  assert.doesNotThrow(() => workflowRule(null));
  assert.doesNotThrow(() => workflowRule(undefined));
});
