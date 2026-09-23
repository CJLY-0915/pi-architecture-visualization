'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canonicalizeModel,
  fingerprintText,
  snapshotPath,
  planSnapshotSave,
} = require('../src/core/persistence');
const { validateModel } = require('../src/core/validation');
const { CODES } = require('../src/core/error-codes');

function node(id, evidenceIds = []) {
  return { id, name: id, type: 'module', state: 'current', status: 'inferred', confidence: 'low', evidenceIds };
}

function edge(id, source, target, evidenceIds = []) {
  return { id, source, target, type: 'depends_on', state: 'current', status: 'inferred', confidence: 'low', evidenceIds };
}

function model(overrides = {}) {
  return {
    schemaVersion: 1,
    project: { id: 'snapshot-test' },
    scope: { roots: ['src'] },
    sourceRevision: 'abc123',
    generatedAt: '2024-05-01T09:30:00Z',
    coverage: { filesScanned: 2, complete: true },
    nodes: [node('a', ['ev.a']), node('b')],
    edges: [edge('a-b', 'a', 'b', ['ev.a'])],
    evidence: [{ id: 'ev.a', path: 'src/a.js', type: 'code' }],
    views: [{ id: 'main' }],
    findings: [{ id: 'finding' }],
    decisions: [{ id: 'decision' }],
    migrationSlices: [{ id: 'slice' }],
    unknowns: [{ id: 'unknown' }],
    ...overrides,
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('semantically equivalent unordered model sets produce identical immutable snapshots', () => {
  const first = model({
    scope: { roots: ['lib', 'src', 'src'] },
    nodes: [node('b', ['ev.a', 'ev.a']), node('a', ['ev.a'])],
    edges: [edge('a-b', 'a', 'b', ['ev.a', 'ev.a'])],
    evidence: [{ id: 'ev.a', path: 'src/a.js', type: 'code' }],
    views: [{ id: 'z' }, { id: 'a' }],
  });
  const second = clone(first);
  second.scope.roots = ['src', 'lib'];
  second.nodes.reverse();
  second.nodes[0].evidenceIds.reverse();
  second.edges[0].evidenceIds = ['ev.a'];
  second.views.reverse();
  second.project = { id: 'snapshot-test' };

  const original = JSON.stringify(first);
  const left = planSnapshotSave({ model: first, now: '2030-01-01T00:00:00Z' });
  const right = planSnapshotSave({ model: second, generatedAt: '2040-01-01T00:00:00Z' });

  assert.equal(left.ok, true);
  assert.equal(right.ok, true);
  assert.equal(left.fingerprint, right.fingerprint);
  assert.equal(left.text, right.text);
  assert.equal(JSON.stringify(first), original);
  assert.deepEqual(left.metadata, {
    schemaVersion: 1,
    projectId: 'snapshot-test',
    sourceRevision: 'abc123',
    generatedAt: '2024-05-01T09:30:00Z',
  });
});

test('relationship and unknown content changes produce different fingerprints', () => {
  const baseline = planSnapshotSave({ model: model() });
  const changedRelationship = model();
  changedRelationship.edges[0].type = 'calls';
  const changedUnknown = model({ unknowns: [{ id: 'unknown', detail: 'unresolved ownership' }] });

  assert.notEqual(planSnapshotSave({ model: changedRelationship }).fingerprint, baseline.fingerprint);
  assert.notEqual(planSnapshotSave({ model: changedUnknown }).fingerprint, baseline.fingerprint);
});

test('canonicalization sorts only declared collections and preserves ordinary array order', () => {
  const input = model({
    unknowns: [{ id: 'z', steps: ['second', 'first'], evidenceIds: ['ev.a', 'ev.a'] }, { id: 'a' }],
  });
  const canonical = canonicalizeModel(input);

  assert.deepEqual(canonical.unknowns.map((entry) => entry.id), ['a', 'z']);
  assert.deepEqual(canonical.unknowns[1].steps, ['second', 'first']);
  assert.deepEqual(canonical.unknowns[1].evidenceIds, ['ev.a']);
  assert.deepEqual(input.unknowns.map((entry) => entry.id), ['z', 'a']);
});

test('fingerprints, paths, and generated text are deterministic and valid', () => {
  const saved = planSnapshotSave({ model: model(), now: '1999-01-01T00:00:00Z' });
  const repeated = planSnapshotSave({ model: model(), now: '2099-01-01T00:00:00Z' });

  assert.equal(saved.text.endsWith('\n'), true);
  assert.equal(saved.fingerprint, fingerprintText(saved.text));
  assert.match(saved.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(saved.path, `architecture/snapshots/${saved.fingerprint}.json`);
  assert.equal(saved.path.includes('model.json'), false);
  assert.equal(saved.path.includes('tmp'), false);
  assert.deepEqual(saved, repeated);
  assert.equal(validateModel(JSON.parse(saved.text)).valid, true);
});

test('snapshotPath accepts only a safe SHA-256 filename', () => {
  const hash = fingerprintText('canonical\n');
  assert.equal(snapshotPath(hash), `architecture/snapshots/${hash}.json`);
  for (const malformed of ['', 'A'.repeat(64), '../' + hash, hash + '.json', 'a'.repeat(63), null, 1]) {
    assert.equal(snapshotPath(malformed), null, String(malformed));
  }
});

test('invalid, circular, and hostile inputs never throw or leak exception details', () => {
  const circular = model();
  circular.extra = circular;
  const hostile = {};
  Object.defineProperty(hostile, 'model', { get() { throw new Error('secret getter detail'); } });

  for (const input of [undefined, null, {}, { model: null }, { model: {} }, { model: circular }, hostile]) {
    let result;
    assert.doesNotThrow(() => { result = planSnapshotSave(input); });
    assert.equal(result.ok, false);
    assert.ok([CODES.INVALID_OPTION, CODES.UNSUPPORTED_INPUT, CODES.INTERNAL_ERROR].includes(result.error.code));
    assert.equal(typeof result.error.message, 'string');
    assert.equal(result.error.message.includes('secret getter detail'), false);
    assert.equal(typeof result.validation.valid, 'boolean', 'validation result shape');
  }
});
