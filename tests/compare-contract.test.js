'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compareModels, ID_ONLY_COLLECTIONS } = require('../src/core/compare');
const { CODES } = require('../src/core/error-codes');

function model(overrides = {}) {
  return {
    schemaVersion: 1, project: { id: 'p' }, scope: { roots: ['src', 'lib'] },
    coverage: { complete: true }, sourceRevision: 'r1', generatedAt: '2024-01-01',
    nodes: [], edges: [], evidence: [], views: [], findings: [], decisions: [], migrationSlices: [], unknowns: [],
    ...overrides,
  };
}
const clone = (value) => JSON.parse(JSON.stringify(value));

test('all generic collections detect same-id content changes and count additions/removals', () => {
  for (const collection of ID_ONLY_COLLECTIONS) {
    const before = model({ [collection]: [{ id: 'same', text: 'before' }, { id: 'removed' }] });
    const after = model({ [collection]: [{ id: 'same', text: 'after' }, { id: 'added' }] });
    const result = compareModels({ before, after });
    assert.equal(result.ok, true);
    const diff = result.idCollections.find((entry) => entry.collection === collection);
    assert.deepEqual(diff.added, ['added']);
    assert.deepEqual(diff.removed, ['removed']);
    assert.deepEqual(diff.changed, [{ id: 'same', fields: [{ field: 'text', before: 'before', after: 'after' }] }]);
    assert.equal(diff.unchanged, 0);
    assert.equal(result.summary.total, 3);
    assert.equal(result.identical, false);
  }
});

test('object keys and declared sets normalize, other arrays preserve order', () => {
  const before = model({ unknowns: [{ id: 'u', data: { b: 2, a: 1 }, evidenceIds: ['b', 'a'], scopeRoots: ['b', 'a'], steps: ['one', 'two'] }] });
  const after = clone(before);
  after.unknowns[0].data = { a: 1, b: 2 };
  after.unknowns[0].evidenceIds.reverse();
  after.unknowns[0].scopeRoots.reverse();
  after.scope.roots.reverse();
  assert.equal(compareModels({ before, after }).identical, true);
  after.unknowns[0].steps.reverse();
  assert.equal(compareModels({ before, after }).identical, false);
});

test('all metadata changes count but generatedAt remains descriptive only', () => {
  const before = model();
  const after = model({ project: { id: 'q' }, schemaVersion: 2, scope: { roots: ['elsewhere'] }, coverage: { complete: false }, sourceRevision: 'r2', generatedAt: '2025-01-01' });
  const result = compareModels({ before, after });
  assert.deepEqual(result.metadataChanges.map((entry) => entry.field), ['project', 'schemaVersion', 'scope', 'coverage', 'sourceRevision']);
  assert.equal(result.summary.total, 5);
  const timestampOnly = compareModels({ before, after: { ...before, generatedAt: after.generatedAt } });
  assert.equal(timestampOnly.identical, true);
  assert.equal(timestampOnly.after.generatedAt, after.generatedAt);
});

test('freshness needs explicit comparable content markers, not paths or model revision', () => {
  const before = model({ evidence: [{ id: 'path', path: 'src/a' }, { id: 'hash', contentHash: 'a' }, { id: 'fp', fingerprint: 'a' }, { id: 'rev', revision: 'a' }, { id: 'flag' }, { id: 'same', contentHash: 'same' }] });
  const after = clone(before);
  after.sourceRevision = 'r2';
  after.evidence[0].path = 'src/b';
  after.evidence[1].contentHash = 'b';
  after.evidence[2].fingerprint = 'b';
  after.evidence[3].revision = 'b';
  after.evidence[4].stale = true;
  after.evidence.push({ id: 'new', path: 'exists' });
  const result = compareModels({ before, after });
  assert.deepEqual(result.evidence.stale.map((entry) => entry.id), ['flag', 'fp', 'hash', 'rev']);
  assert.deepEqual(result.evidence.freshnessUnknown.map((entry) => entry.id), ['new', 'path']);
  assert.ok(result.evidence.changed.some((entry) => entry.id === 'hash'));
  const missingBasis = clone(before);
  delete missingBasis.evidence[1].contentHash;
  assert.ok(compareModels({ before, after: missingBasis }).evidence.freshnessUnknown.some((entry) => entry.id === 'hash'));
});

test('stable rename is counted once and field diffs derive confidence changes', () => {
  const before = model({ nodes: [{ id: 'n', name: 'old', confidence: 'low' }], edges: [{ id: 'e', confidence: 'low' }] });
  const after = clone(before);
  after.nodes[0].name = 'new';
  let result = compareModels({ before, after });
  assert.equal(result.nodes.renamed[0].basis, 'stable_id');
  assert.equal(result.summary.total, 1);
  assert.equal(result.summary.renamed, 1);
  after.nodes[0].confidence = 'high';
  after.edges[0].confidence = 'high';
  result = compareModels({ before, after });
  assert.equal(result.confidenceChanges.length, 2);
  assert.ok(result.nodes.changed[0].fields.some((entry) => entry.field === 'confidence'));
  assert.ok(result.edges.changed[0].fields.some((entry) => entry.field === 'confidence'));
});

test('path-based rename remains explicitly a candidate', () => {
  const before = model({ nodes: [{ id: 'old', type: 'module', evidenceIds: ['ev'] }], evidence: [{ id: 'ev', path: 'src/a' }] });
  const after = clone(before);
  after.nodes[0].id = 'new';
  const result = compareModels({ before, after });
  assert.deepEqual(result.nodes.renamed, []);
  assert.equal(result.renameCandidates[0].candidate, true);
  assert.equal(result.summary.total, 2);
});

test('malformed collections and duplicate IDs are rejected, never identical', () => {
  for (const collection of ['nodes', 'edges', 'evidence', ...ID_ONLY_COLLECTIONS]) {
    for (const value of [undefined, null, {}, [null], [{ id: '' }], [{ id: 'x' }, { id: 'x' }]]) {
      const broken = model({ [collection]: value });
      const result = compareModels({ before: broken, after: broken });
      assert.equal(result.ok, false, collection);
      assert.equal(result.identical, null);
      assert.ok([CODES.UNSUPPORTED_INPUT, CODES.DUPLICATE_ID].includes(result.error.code));
      assert.ok(result.error.path.startsWith(`before.${collection}`));
    }
  }
});

test('comparison is deterministic, immutable, and retains exception details', () => {
  const before = model({ nodes: [{ id: 'b' }, { id: 'a' }] });
  const snapshot = JSON.stringify(before);
  const after = clone(before);
  after.nodes.reverse();
  const first = compareModels({ before, after });
  assert.equal(first.identical, true);
  assert.deepEqual(compareModels({ before, after }), first);
  assert.equal(JSON.stringify(before), snapshot);
  const broken = model();
  Object.defineProperty(broken, 'nodes', { get() { throw new Error('nodes unavailable'); } });
  const failed = compareModels({ before: broken, after });
  assert.equal(failed.error.code, CODES.INTERNAL_ERROR);
  assert.match(failed.error.message, /nodes unavailable/);
});
