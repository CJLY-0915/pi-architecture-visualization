'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('../fixtures/valid-minimal-model.json');
const manifest = require('../manifest.json');
const { createSnapshotPlanTool } = require('../src/host/snapshot-plan-tool');
const { fingerprintText } = require('../src/core/persistence');

function createHost(text = JSON.stringify(fixture)) {
  const calls = { stat: [], readText: [], writeText: [] };
  return {
    calls,
    host: { fs: {
      stat: async (path) => {
        calls.stat.push(path);
        return { size: Buffer.byteLength(text, 'utf8'), mtimeMs: 0 };
      },
      readText: async (path) => {
        calls.readText.push(path);
        return text;
      },
      writeText: async (...args) => { calls.writeText.push(args); },
    } },
  };
}

test('snapshot plan tool is declared low-risk and only reads a validated model', async () => {
  const { host, calls } = createHost();
  const tool = createSnapshotPlanTool(host);
  const declared = manifest.contributes.agentTools.find((entry) => entry.name === 'architecture_snapshot_plan');
  assert.equal(tool.risk, 'low');
  assert.deepEqual(tool.schema, declared.schema);

  const result = await tool.execute({ path: 'fixtures/valid-minimal-model.json' });
  assert.equal(result.ok, true);
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(result.path, `architecture/snapshots/${result.fingerprint}.json`);
  assert.equal(result.path.includes('model.json'), false);
  assert.equal(result.path.includes('.tmp'), false);
  assert.equal(result.text.endsWith('\n'), true);
  assert.equal(result.fingerprint, fingerprintText(result.text));
  assert.equal(JSON.parse(result.text).project.id, 'sample-billing');
  assert.deepEqual(calls.stat, ['fixtures/valid-minimal-model.json']);
  assert.deepEqual(calls.readText, ['fixtures/valid-minimal-model.json']);
  assert.deepEqual(calls.writeText, []);
});

test('snapshot planning rejects unsafe paths before host I/O', async () => {
  const { host, calls } = createHost();
  const tool = createSnapshotPlanTool(host);
  for (const path of ['', '../model.json', '/model.json', 'C:/model.json', 'a\\b.json', 'a//b.json']) {
    const result = await tool.execute({ path });
    assert.equal(result.ok, false);
  }
  assert.deepEqual(calls.stat, []);
  assert.deepEqual(calls.readText, []);
  assert.deepEqual(calls.writeText, []);
});

test('snapshot planning rejects invalid model content without selecting a mutable path', async () => {
  const { host, calls } = createHost('{');
  const tool = createSnapshotPlanTool(host);
  const result = await tool.execute({ path: 'architecture/model.json' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_JSON');
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'path'), false);
  assert.deepEqual(calls.writeText, []);
});
