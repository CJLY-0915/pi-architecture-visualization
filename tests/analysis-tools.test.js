'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAnalysisTools, boundResponse, MAX_RESPONSE_BYTES } = require('../src/host/analysis-tools');
const { MAX_MODEL_BYTES, MAX_MODEL_CHARS } = require('../src/host/read-model');
const manifest = require('../manifest.json');
const fixture = require('../fixtures/valid-minimal-model.json');

function hostWith(value = JSON.stringify(fixture)) {
  const reads = [];
  const stats = [];
  const host = { fs: {
    stat: async (path) => {
      stats.push(path);
      if (value instanceof Error) throw value;
      return { size: typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 0, mtimeMs: 0 };
    },
    readText: async (path) => {
      reads.push(path);
      if (value instanceof Error) throw value;
      return value;
    },
  } };
  const tools = Object.fromEntries(createAnalysisTools(host).map((tool) => [tool.name, tool]));
  return { tools, reads, stats };
}

const queryArgs = { path: 'architecture/model.json', mode: 'neighbours', targets: ['container.api'] };

test('P4 tool names, risk and schemas match the manifest exactly', () => {
  const { tools } = hostWith();
  for (const [name, tool] of Object.entries(tools)) {
    const declared = manifest.contributes.agentTools.find((entry) => entry.name === name);
    assert.deepEqual(tool.schema, declared.schema);
    assert.equal(tool.risk, 'low');
    assert.equal(name.startsWith('plugin_'), false);
  }
  assert.equal(manifest.permissions.includes('fs.write'), false);
});

test('query tool loads a validated model and preserves incomplete coverage', async () => {
  const { tools, reads } = hostWith();
  const result = await tools.architecture_query.execute(queryArgs);
  assert.equal(result.ok, true);
  assert.deepEqual(result.neighbours.map((node) => node.id).sort(), ['actor.operator', 'module.invoice']);
  assert.equal(result.modelContext.coverage.complete, false);
  assert.equal(result.sourceContentVerified, false);
  assert.deepEqual(reads, ['architecture/model.json']);
});

test('impact tool accepts explicit evidence paths without guessing Git state', async () => {
  const { tools } = hostWith();
  const result = await tools.architecture_impact.execute({ path: queryArgs.path, targets: ['src/invoice/store.js'], direction: 'downstream' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.targets, [{ input: 'src/invoice/store.js', matchedNodeIds: ['container.api', 'datastore.billingdb', 'module.invoice'] }]);
  assert.equal(result.sourceContentVerified, false);
});

test('compare tool reads exactly two snapshots and reports identity', async () => {
  const { tools, reads } = hostWith();
  const result = await tools.architecture_compare.execute({ beforePath: 'architecture/old.json', afterPath: queryArgs.path });
  assert.equal(result.ok, true);
  assert.equal(result.identical, true);
  assert.equal(result.sourceContentVerified, false);
  assert.deepEqual(reads, ['architecture/old.json', queryArgs.path]);
});

test('unsafe paths and budgets are rejected before any read', async () => {
  const { tools, reads } = hostWith();
  for (const path of ['../x', '/x', 'C:/x', 'a\\b', 'a//b', './x', 'x\u0000y']) {
    assert.equal((await tools.architecture_query.execute({ path })).error.code, 'INVALID_PATH');
    assert.equal((await tools.architecture_compare.execute({ beforePath: queryArgs.path, afterPath: path })).error.code, 'INVALID_PATH');
  }
  for (const args of [{ maxNodes: 2001 }, { maxDepth: 33 }, { maxTimeMs: 1001 }, { maxCycles: 101 }, { maxNodes: 1.2 }, { now: 5 }, { risk: 'high' }, { mode: 'unknown' }]) {
    assert.equal((await tools.architecture_query.execute({ path: queryArgs.path, ...args })).error.code, 'invalid_option');
  }
  assert.deepEqual(reads, []);
});

test('missing explicit impact targets or comparison snapshots are explicit and never read files', async () => {
  const { tools, reads } = hostWith();
  assert.equal((await tools.architecture_impact.execute({ path: queryArgs.path })).error.code, 'change_source_unavailable');
  assert.equal((await tools.architecture_compare.execute({ beforePath: queryArgs.path })).error.code, 'change_source_unavailable');
  // Defence in depth: unknown legacy source hints are still never interpreted.
  assert.equal((await tools.architecture_impact.execute({ branch: 'main' })).error.code, 'change_source_unavailable');
  assert.deepEqual(reads, []);
});


test('blank legacy source fields are ignored only for stale host tool metadata', async () => {
  const { tools } = hostWith();
  const result = await tools.architecture_impact.execute({
    path: queryArgs.path,
    targets: ['module.invoice'],
    branch: ' ',
    changeSource: ' ',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.impacted.map((entry) => entry.nodeId), ['datastore.billingdb']);
});
test('JSON, text size and model structure failures do not enter analysis', async () => {
  for (const [text, code] of [
    ['{', 'INVALID_JSON'],
    ['x'.repeat(MAX_MODEL_BYTES + 1), 'MODEL_TOO_LARGE'],
    [JSON.stringify({ ...fixture, nodes: [] }), 'INVALID_MODEL'],
    [42, 'READ_FAILED'],
  ]) {
    const { tools, reads } = hostWith(text);
    const result = await tools.architecture_query.execute(queryArgs);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
    assert.equal(result.neighbours, undefined);
    if (code === 'MODEL_TOO_LARGE') assert.deepEqual(reads, []);
  }
});

test('host permission failure is preserved without leaking host error text', async () => {
  const error = Object.assign(new Error('private C:/secret/project'), { code: 'PERMISSION_DENIED' });
  const { tools } = hostWith(error);
  const result = await tools.architecture_query.execute(queryArgs);
  assert.equal(result.error.code, 'PERMISSION_DENIED');
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('oversize responses fail visibly rather than silently losing entries', async () => {
  const result = boundResponse({ ok: true, nodes: ['x'.repeat(MAX_RESPONSE_BYTES)] });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'RESULT_TOO_LARGE');
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < MAX_RESPONSE_BYTES);
  const huge = JSON.parse(JSON.stringify(fixture));
  huge.nodes[0].name = 'x'.repeat(MAX_RESPONSE_BYTES);
  const { tools } = hostWith(JSON.stringify(huge));
  const actual = await tools.architecture_query.execute({ path: queryArgs.path, mode: 'filter' });
  assert.equal(actual.error.code, 'RESULT_TOO_LARGE');
});

test('invalid arguments cannot invoke the host or throw', async () => {
  const { tools, reads } = hostWith();
  for (const tool of Object.values(tools)) {
    for (const input of [null, undefined, [], 1, 'x']) {
      assert.equal((await tool.execute(input)).error.code, 'invalid_option');
    }
  }
  assert.deepEqual(reads, []);
});
