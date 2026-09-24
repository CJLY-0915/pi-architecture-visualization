'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { planModelSave, applyModelSave, SAVE_DECISIONS } = require('../src/host/save-model.js');
const { validateModel } = require('../src/core/validation.js');
const model = require('../fixtures/valid-minimal-model.json');

const TARGET = 'architecture/model.json';

function createHost(files, options = {}) {
  const writes = [];
  const host = {
    writes,
    files,
    fs: {
      stat: async (path) => {
        if (options.statFails === true) throw Object.assign(new Error('stat refused'), { code: 'PERMISSION_DENIED' });
        const value = files[path];
        if (value === undefined) throw Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
        return { size: Buffer.byteLength(value, 'utf8'), mtimeMs: 0 };
      },
      readText: async (path) => {
        const value = files[path];
        if (value === undefined) throw Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
        return value;
      },
      writeText: async (path, content) => {
        if (options.writeFails === true) throw Object.assign(new Error('write refused'), { code: 'PERMISSION_DENIED' });
        writes.push({ path, content });
        files[path] = content;
      },
    },
  };
  return host;
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

test('a plan names the target, its state and the counts on the new side', async () => {
  const host = createHost({});
  const result = await planModelSave(host, { model, path: TARGET });
  assert.equal(result.ok, true);
  assert.equal(result.save.path, TARGET);
  assert.equal(result.save.targetState, 'missing');
  assert.equal(result.save.action, 'create');
  assert.equal(result.save.existing, null);
  assert.equal(result.save.new.nodes, model.nodes.length);
  assert.equal(result.save.new.edges, model.edges.length);
  assert.equal(result.save.new.evidence, model.evidence.length);
  assert.match(result.save.snapshotPath, /^architecture\/snapshots\/[a-f0-9]{64}\.json$/);
  assert.equal(result.save.snapshotPresent, false);
  assert.deepEqual(host.writes, [], 'a plan must not write');
});

test('a plan for an existing target reports what would be replaced', async () => {
  const files = { [TARGET]: JSON.stringify(model) };
  const host = createHost(files);
  const result = await planModelSave(host, { model, path: TARGET });
  assert.equal(result.ok, true);
  assert.equal(result.save.targetState, 'present');
  assert.equal(result.save.action, 'recheck');
  assert.equal(result.save.existing.readable, true);
  assert.equal(result.save.existing.valid, true);
  assert.equal(result.save.existing.nodes, model.nodes.length);
  assert.equal(typeof result.save.targetBytes, 'number');
  assert.deepEqual(host.writes, []);
});

test('an unreadable or invalid file at the target is described, not hidden', async () => {
  const broken = clone(model);
  broken.edges[0].target = 'node.missing';

  // Not JSON at all: nothing can be said about its contents.
  const unreadable = createHost({ [TARGET]: '{ not json' });
  const unreadablePlan = await planModelSave(unreadable, { model, path: TARGET });
  assert.equal(unreadablePlan.ok, true);
  assert.equal(unreadablePlan.save.existing.readable, false);

  // Parsed but structurally invalid: the panel must not quote counts from it.
  const invalid = createHost({ [TARGET]: JSON.stringify(broken) });
  const invalidPlan = await planModelSave(invalid, { model, path: TARGET });
  assert.equal(invalidPlan.ok, true);
  assert.equal(invalidPlan.save.existing.readable, true);
  assert.equal(invalidPlan.save.existing.valid, false);
  assert.equal(invalidPlan.save.existing.nodes, undefined, 'no counts may be claimed for an invalid model');
});

test('a target the host refuses to inspect is unknown, not missing', async () => {
  const host = createHost({}, { statFails: true });
  const result = await planModelSave(host, { model, path: TARGET });
  assert.equal(result.ok, true);
  assert.equal(result.save.targetState, 'unknown');
  assert.equal(result.save.action, 'recheck');
  assert.equal(result.save.existing, null, 'an uninspectable target may not be described');
});

test('creating writes canonical text and confirms the size', async () => {
  const files = {};
  const host = createHost(files);
  const result = await applyModelSave(host, { model, path: TARGET, decision: 'create' });
  assert.equal(result.ok, true);
  assert.equal(result.save.written, true);
  assert.equal(result.save.verified, true);
  assert.equal(result.save.decision, 'create');
  assert.equal(host.writes.length, 1);
  assert.equal(host.writes[0].path, TARGET);
  assert.equal(result.save.bytes, Buffer.byteLength(host.writes[0].content, 'utf8'));
  assert.equal(validateModel(JSON.parse(host.writes[0].content)).valid, true);
  // The written text is the canonical form the snapshot fingerprint is taken of.
  const fingerprint = crypto.createHash('sha256').update(host.writes[0].content, 'utf8').digest('hex');
  assert.equal(result.save.path, TARGET);
  assert.equal(`architecture/snapshots/${fingerprint}.json`, await snapshotPathFor(model));
});

async function snapshotPathFor(value) {
  const host = createHost({});
  const result = await planModelSave(host, { model: value, path: TARGET });
  return result.save.snapshotPath;
}

test('creating refuses a target that is no longer absent and writes nothing', async () => {
  const files = { [TARGET]: JSON.stringify(model) };
  const host = createHost(files);
  const before = files[TARGET];
  const result = await applyModelSave(host, { model, path: TARGET, decision: 'create' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'TARGET_EXISTS');
  assert.deepEqual(host.writes, []);
  assert.equal(files[TARGET], before, 'the existing file must be untouched');
});

test('a snapshot leaves the target alone and is content-addressed', async () => {
  const files = { [TARGET]: JSON.stringify(model) };
  const host = createHost(files);
  const changed = clone(model);
  changed.nodes[0].description = 'a different scan';

  const result = await applyModelSave(host, { model: changed, path: TARGET, decision: 'snapshot' });
  assert.equal(result.ok, true);
  assert.equal(result.save.written, true);
  assert.notEqual(result.save.path, TARGET);
  assert.match(result.save.path, /^architecture\/snapshots\/[a-f0-9]{64}\.json$/);
  assert.equal(host.writes.length, 1);
  assert.equal(files[TARGET], JSON.stringify(model), 'the standard path must not move');

  // The same content again is recognised instead of written twice.
  const again = await applyModelSave(host, { model: changed, path: TARGET, decision: 'snapshot' });
  assert.equal(again.ok, true);
  assert.equal(again.save.written, false);
  assert.equal(again.save.alreadyPresent, true);
  assert.equal(host.writes.length, 1, 'an identical snapshot must not be written again');

  // A different model gets a different address, so snapshots never overwrite.
  const other = await applyModelSave(host, { model, path: TARGET, decision: 'snapshot' });
  assert.equal(other.ok, true);
  assert.equal(host.writes.length, 2);
  assert.notEqual(other.save.path, result.save.path);
});

test('the snapshot address ignores key order, because the text is canonical', async () => {
  const reordered = {};
  for (const key of Object.keys(model).reverse()) reordered[key] = model[key];
  const first = await snapshotPathFor(model);
  const second = await snapshotPathFor(reordered);
  assert.equal(first, second);
});

test('overwriting replaces the target and names what it replaced', async () => {
  const files = { [TARGET]: JSON.stringify(model) };
  const host = createHost(files);
  const changed = clone(model);
  // One more node than the file on disk, so the two sides really differ.
  changed.nodes.push({ ...model.nodes[3], id: 'datastore.archive', name: 'Archive Database' });

  const result = await applyModelSave(host, { model: changed, path: TARGET, decision: 'overwrite' });
  assert.equal(result.ok, true);
  assert.equal(result.save.written, true);
  assert.equal(result.save.path, TARGET);
  assert.equal(result.save.existing.nodes, model.nodes.length);
  assert.equal(result.save.new.nodes, changed.nodes.length);
  assert.equal(host.writes.length, 1);
  assert.equal(validateModel(JSON.parse(files[TARGET])).valid, true);
  assert.ok(files[TARGET].includes('datastore.archive'), 'the new content must be what landed');
});

test('overwriting refuses a target it could not inspect', async () => {
  const host = createHost({}, { statFails: true });
  const result = await applyModelSave(host, { model, path: TARGET, decision: 'overwrite' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'TARGET_STATE_UNKNOWN');
  assert.deepEqual(host.writes, []);
});

test('a model that fails validation is never written', async () => {
  const broken = clone(model);
  broken.edges[0].target = 'node.missing';
  for (const bad of [broken]) {
    const host = createHost({});
    const result = await applyModelSave(host, { model: bad, path: TARGET, decision: 'create' });
    assert.equal(result.ok, false, `${JSON.stringify(bad)} must be refused`);
    assert.equal(result.error.code, 'INVALID_MODEL');
    assert.deepEqual(host.writes, []);
  }
});

test('a request that carries no model at all is refused before any host call', async () => {
  for (const bad of [null, undefined, 'model', 42, []]) {
    const host = createHost({});
    const result = await applyModelSave(host, { model: bad, path: TARGET, decision: 'create' });
    assert.equal(result.ok, false, `${JSON.stringify(bad)} must be refused`);
    assert.equal(result.error.code, 'invalid_option');
    assert.deepEqual(host.writes, []);
  }
});

test('unsafe target paths are refused without touching the host', async () => {
  const host = createHost({});
  for (const path of ['../model.json', '/model.json', 'C:/model.json', 'a\\b.json', 'a//b.json', './model.json', '', '.', 'architecture/../../model.json']) {
    for (const decision of [undefined, 'create', 'snapshot', 'overwrite']) {
      const result = decision === undefined
        ? await planModelSave(host, { model, path })
        : await applyModelSave(host, { model, path, decision });
      assert.equal(result.ok, false, `${path} with ${decision} must be refused`);
      assert.equal(result.error.code, 'INVALID_PATH');
    }
  }
  assert.deepEqual(host.writes, []);
});

test('a refused write is reported with the host code and nothing is claimed', async () => {
  const host = createHost({}, { writeFails: true });
  const result = await applyModelSave(host, { model, path: TARGET, decision: 'create' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'PERMISSION_DENIED');
  assert.equal(host.writes.length, 0);
});

test('a write that cannot be confirmed at the expected size is not reported as saved', async () => {
  const files = {};
  const host = createHost(files);
  host.fs.writeText = async (path, content) => { host.writes.push({ path, content }); files[path] = 'short'; };
  const result = await applyModelSave(host, { model, path: TARGET, decision: 'create' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'WRITE_UNVERIFIED');
});

test('the three decisions are the only accepted ones', async () => {
  assert.deepEqual([...SAVE_DECISIONS], ['create', 'snapshot', 'overwrite']);
});
