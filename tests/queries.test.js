'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createGraph } = require('../src/core/graph');
const { queryModel, queryNeighbours, queryPaths, queryCycles } = require('../src/core/query');
const { compareModels } = require('../src/core/compare');
const { CODES, isKnownCode } = require('../src/core/error-codes');
const { validateModel } = require('../src/core/validation');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'valid-minimal-model.json'), 'utf8'));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// A model that exercises every shape the queries must survive: a cycle, a
// shared node reached by two paths, a node beyond the depth bound, an edge with
// a relation type outside the v1 set, and an edge pointing at a missing node.
function shapeModel() {
  return {
    nodes: [
      { id: 'a', name: 'A', type: 'module', state: 'current', status: 'inferred', confidence: 'medium', evidenceIds: [] },
      { id: 'b', name: 'B', type: 'module', state: 'current', status: 'inferred', confidence: 'medium', evidenceIds: [] },
      { id: 'c', name: 'C', type: 'module', state: 'current', status: 'inferred', confidence: 'low', evidenceIds: [] },
      { id: 'd', name: 'D', type: 'module', state: 'current', status: 'inferred', confidence: 'low', evidenceIds: [] },
      { id: 'e', name: 'E', type: 'module', state: 'current', status: 'unknown', confidence: 'unknown', evidenceIds: [] },
    ],
    edges: [
      { id: 'e.ab', source: 'a', target: 'b', type: 'calls', state: 'current', status: 'inferred', confidence: 'medium', evidenceIds: [] },
      { id: 'e.bc', source: 'b', target: 'c', type: 'calls', state: 'current', status: 'inferred', confidence: 'medium', evidenceIds: [] },
      { id: 'e.ca', source: 'c', target: 'a', type: 'calls', state: 'current', status: 'inferred', confidence: 'medium', evidenceIds: [] },
      { id: 'e.cd', source: 'c', target: 'd', type: 'calls', state: 'current', status: 'inferred', confidence: 'low', evidenceIds: [] },
      { id: 'e.de', source: 'd', target: 'e', type: 'calls', state: 'current', status: 'inferred', confidence: 'low', evidenceIds: [] },
      { id: 'e.ae', source: 'a', target: 'e', type: 'teleports', state: 'current', status: 'inferred', confidence: 'low', evidenceIds: [] },
      { id: 'e.missing', source: 'e', target: 'ghost', type: 'calls', state: 'current', status: 'inferred', confidence: 'low', evidenceIds: [] },
    ],
    evidence: [],
  };
}

function stopReasons(result) {
  return result.stops.map((stop) => stop.reason).sort();
}

test('graph index is ordered independently of input array order', () => {
  const forward = createGraph(shapeModel());
  const reversed = clone(shapeModel());
  reversed.nodes.reverse();
  reversed.edges.reverse();
  const backward = createGraph(reversed);

  assert.deepEqual(forward.nodes.map((node) => node.id), backward.nodes.map((node) => node.id));
  assert.deepEqual(forward.edges.map((edge) => edge.id), backward.edges.map((edge) => edge.id));
  assert.deepEqual(forward.nodes.map((node) => node.id), ['a', 'b', 'c', 'd', 'e']);
});

test('graph index reports dangling references instead of dropping them', () => {
  const graph = createGraph(shapeModel());
  assert.deepEqual(graph.dangling, [{ id: 'e.missing', reason: 'unknown_target', nodeId: 'ghost' }]);
});

test('graph index treats a malformed model as empty rather than throwing', () => {
  for (const input of [undefined, null, 42, 'x', [], { nodes: 'nope', edges: 7, evidence: null }]) {
    const graph = createGraph(input);
    assert.deepEqual(graph.nodes, []);
    assert.deepEqual(graph.edges, []);
    assert.deepEqual(graph.dangling, []);
  }
});

test('queryModel filters by id, type, status and confidence', () => {
  const byId = queryModel({ model: FIXTURE, ids: ['container.api'] });
  assert.deepEqual(byId.nodes.map((node) => node.id), ['container.api']);

  const byType = queryModel({ model: FIXTURE, types: ['module'] });
  assert.deepEqual(byType.nodes.map((node) => node.id), ['module.invoice']);

  const byMinConfidence = queryModel({ model: FIXTURE, minConfidence: 'high' });
  assert.deepEqual(byMinConfidence.nodes.map((node) => node.id), ['container.api', 'module.invoice']);

  const byStatus = queryModel({ model: FIXTURE, statuses: ['unknown'] });
  assert.deepEqual(byStatus.nodes.map((node) => node.id), ['actor.operator']);

  const byEvidenceType = queryModel({ model: FIXTURE, evidenceTypes: ['document'] });
  assert.deepEqual(byEvidenceType.nodes.map((node) => node.id), ['container.api', 'sys.billing']);

  const byEvidencePath = queryModel({ model: FIXTURE, evidencePath: 'src/invoice/store.js' });
  assert.deepEqual(byEvidencePath.nodes.map((node) => node.id), ['module.invoice']);
});

test('queryModel keeps only edges whose endpoints survived the filter', () => {
  const result = queryModel({ model: FIXTURE, ids: ['container.api', 'module.invoice'] });
  assert.deepEqual(result.edges.map((edge) => edge.id), ['edge.api.invoice']);
  assert.equal(result.totalEdges, 1);
});

test('queryModel reports invalid options instead of guessing', () => {
  const bad = queryModel({ model: FIXTURE, minConfidence: 'certain' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'invalid_option');
  assert.equal(bad.error.path, 'options.minConfidence');

  const notArray = queryModel({ model: FIXTURE, types: 'module' });
  assert.equal(notArray.ok, false);
  assert.equal(notArray.error.path, 'options.types');

  const zeroLimit = queryModel({ model: FIXTURE, limit: 0 });
  assert.equal(zeroLimit.ok, true);
  assert.equal(zeroLimit.nodes.length, 0);
});

test('queryModel truncates visibly instead of silently', () => {
  const result = queryModel({ model: FIXTURE, limit: 2 });
  assert.equal(result.truncated, true);
  assert.equal(result.nodes.length, 2);
  assert.equal(result.totalNodes, 5);
});

test('queryNeighbours resolves both directions and rejects unknown seeds', () => {
  const both = queryNeighbours({ model: FIXTURE, targets: ['container.api'] });
  assert.deepEqual(both.neighbours.map((entry) => `${entry.id}:${entry.direction}`), ['actor.operator:incoming', 'module.invoice:outgoing']);

  const upstream = queryNeighbours({ model: FIXTURE, targets: ['container.api'], direction: 'upstream' });
  assert.deepEqual(upstream.neighbours.map((entry) => entry.id), ['actor.operator']);

  const filtered = queryNeighbours({ model: FIXTURE, targets: ['container.api'], relationTypes: ['contains'] });
  assert.deepEqual(filtered.neighbours.map((entry) => entry.id), ['module.invoice']);

  const missing = queryNeighbours({ model: FIXTURE, targets: ['nope'] });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, CODES.UNKNOWN_NODE);
  assert.deepEqual(missing.neighbours, []);
});

test('queryNeighbours surfaces an unknown relation type instead of following it', () => {
  const result = queryNeighbours({ model: shapeModel(), targets: ['a'] });
  assert.ok(stopReasons(result).includes('unknown_relation_type'));
  assert.equal(result.neighbours.some((entry) => entry.id === 'e'), false);
});

test('queryNeighbours surfaces an edge that resolves to an undeclared node', () => {
  const result = queryNeighbours({ model: shapeModel(), targets: ['e'] });
  assert.ok(stopReasons(result).includes('unsupported_input'));
});

test('queryPaths finds simple paths and refuses to loop', () => {
  const direct = queryPaths({ model: FIXTURE, from: 'actor.operator', to: 'container.api' });
  assert.equal(direct.paths.length, 1);
  assert.deepEqual(direct.paths[0].map((step) => step.nodeId), ['actor.operator', 'container.api']);

  const cyclic = queryPaths({ model: shapeModel(), from: 'a', to: 'c', direction: 'downstream', maxDepth: 5 });
  assert.ok(cyclic.paths.length >= 1);
  for (const trail of cyclic.paths) {
    const ids = trail.map((step) => step.nodeId);
    assert.equal(new Set(ids).size, ids.length, 'a path must not repeat a node');
  }
});

test('queryPaths reports an unknown node instead of returning an empty path list', () => {
  const result = queryPaths({ model: FIXTURE, from: 'nope', to: 'container.api' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, CODES.UNKNOWN_NODE);
  assert.equal(result.error.path, 'from');
});

test('queryPaths stops at maxDepth and says so', () => {
  const result = queryPaths({ model: shapeModel(), from: 'a', to: 'e', direction: 'downstream', maxDepth: 2 });
  assert.ok(stopReasons(result).includes('max_depth'));
  assert.equal(result.truncated, true);
});

test('queryCycles returns the full loop with its closing edges and does not call it a defect', () => {
  const result = queryCycles({ model: shapeModel(), direction: 'downstream' });
  assert.equal(result.ok, true);
  const loop = result.cycles.find((cycle) => cycle.nodeIds.join(',') === 'a,b,c');
  assert.ok(loop, 'the a -> b -> c -> a loop must be found in full');
  assert.deepEqual(loop.edges.map((edge) => edge.id), ['e.ab', 'e.bc', 'e.ca']);
  assert.equal(loop.isDefect, null);
  assert.equal(typeof loop.note, 'string');

  const acyclic = queryCycles({ model: FIXTURE, direction: 'downstream' });
  assert.deepEqual(acyclic.cycles, []);
  assert.deepEqual(acyclic.stops.map((stop) => stop.reason), ['frontier_exhausted']);
});

test('queryCycles surfaces an unknown relation type rather than walking it', () => {
  const result = queryCycles({ model: shapeModel(), direction: 'downstream' });
  assert.ok(stopReasons(result).includes('unknown_relation_type'));
});

test('queries are deterministic and independent of input array order', () => {
  const shuffled = clone(FIXTURE);
  shuffled.nodes.reverse();
  shuffled.edges.reverse();
  shuffled.evidence.reverse();

  for (const run of [
    (model) => queryModel({ model, limit: 3 }),
    (model) => queryNeighbours({ model, targets: ['container.api'] }),
    (model) => queryPaths({ model, from: 'actor.operator', to: 'datastore.billingdb' }),
    (model) => queryCycles({ model }),
  ]) {
    const expected = run(FIXTURE);
    assert.deepEqual(run(FIXTURE), expected);
    assert.deepEqual(run(shuffled), expected, 'array order must not change a query result');
  }
});

test('queries never throw on malformed input', () => {
  const inputs = [undefined, null, 7, 'text', [], { model: null }, { model: { nodes: 'x' } }, { model: {}, targets: [] }];
  for (const input of inputs) {
    for (const run of [queryModel, queryNeighbours, queryPaths, queryCycles]) {
      const result = run(input);
      assert.equal(typeof result.ok, 'boolean');
      if (result.ok === false) assert.equal(isKnownCode(result.error.code), true);
    }
  }
});


test('a model with an id-less node or edge does not make a query throw', () => {
  const broken = { nodes: [{ name: 'no id' }, null, 'text'], edges: [{ source: 'a', target: 'a' }, null], evidence: [null] };
  // A model whose entries carry no id cannot resolve a node, so a query must
  // fail with a registered code instead of throwing or inventing a result.
  for (const run of [queryModel, queryNeighbours, queryPaths, queryCycles]) {
    const result = run({ model: broken, targets: ['a'], from: 'a', to: 'a' });
    assert.equal(typeof result.ok, 'boolean');
    if (result.ok === false) assert.equal(isKnownCode(result.error.code), true);
  }
});

test('compareModels reports added, removed and changed records by stable id', () => {
  const before = clone(FIXTURE);
  const after = clone(FIXTURE);
  after.nodes.push({ id: 'module.payment', name: 'Payment Module', type: 'module', state: 'current', status: 'unknown', confidence: 'unknown', evidenceIds: [] });
  after.nodes = after.nodes.filter((node) => node.id !== 'actor.operator');
  after.nodes.find((node) => node.id === 'module.invoice').confidence = 'medium';
  after.evidence = after.evidence.filter((entry) => entry.id !== 'ev.readme');
  after.nodes.find((node) => node.id === 'sys.billing').evidenceIds = ['ev.main'];

  const result = compareModels({ before, after });
  assert.equal(result.ok, true);
  assert.deepEqual(result.nodes.added.map((entry) => entry.id), ['module.payment']);
  assert.deepEqual(result.nodes.removed.map((entry) => entry.id), ['actor.operator']);
  assert.deepEqual(result.edges.removed, [], 'removing a node must not invent an edge deletion');
  assert.deepEqual(result.evidence.removed.map((entry) => entry.id), ['ev.readme']);

  const invoiceChange = result.nodes.changed.find((entry) => entry.id === 'module.invoice');
  assert.deepEqual(invoiceChange.fields, [{ field: 'confidence', before: 'high', after: 'medium' }]);
  assert.equal(result.identical, false);
  assert.ok(result.summary.total > 0);
});

test('compareModels reports a rename only from a surviving stable id or marked evidence', () => {
  const before = clone(FIXTURE);
  const after = clone(FIXTURE);
  after.nodes.find((node) => node.id === 'module.invoice').name = 'Invoicing Module';
  const renamed = compareModels({ before, after });
  assert.deepEqual(renamed.nodes.renamed, [{ id: 'module.invoice', from: 'Invoice Module', to: 'Invoicing Module', basis: 'stable_id' }]);

  const rekeyed = clone(FIXTURE);
  rekeyed.nodes = rekeyed.nodes.map((node) => (node.id === 'module.invoice' ? Object.assign({}, node, { id: 'module.billing', name: 'Billing Module' }) : node));
  const candidate = compareModels({ before, after: rekeyed });
  assert.deepEqual(candidate.nodes.renamed, []);
  assert.equal(candidate.renameCandidates.length, 1);
  assert.equal(candidate.renameCandidates[0].basis, 'evidence');
  assert.equal(candidate.renameCandidates[0].fromId, 'module.invoice');
  assert.equal(candidate.renameCandidates[0].toId, 'module.billing');
  assert.equal(candidate.identical, false, 'an unconfirmed rename keeps the comparison from claiming identity');
});

test('an ambiguous evidence match is not reported as a rename candidate', () => {
  const before = clone(FIXTURE);
  before.nodes = [{ id: 'n1', name: 'N1', type: 'module', state: 'current', status: 'inferred', confidence: 'low', evidenceIds: ['ev'] }, { id: 'n2', name: 'N2', type: 'module', state: 'current', status: 'inferred', confidence: 'low', evidenceIds: ['ev'] }];
  before.edges = [];
  before.evidence = [{ id: 'ev', path: 'src/a.js', type: 'code' }];
  const after = clone(before);
  after.nodes = [{ id: 'n3', name: 'N3', type: 'module', state: 'current', status: 'inferred', confidence: 'low', evidenceIds: ['ev'] }];
  const result = compareModels({ before, after });
  assert.deepEqual(result.renameCandidates, []);
  assert.equal(result.nodes.removed.length, 2);
  assert.equal(result.nodes.added.length, 1);
});

test('nodes without evidence are never paired as a rename', () => {
  const record = (id, name) => ({ id, name, type: 'module', state: 'current', status: 'inferred', confidence: 'low', evidenceIds: [] });
  const before = clone(FIXTURE);
  before.nodes = [record('old', 'Same')];
  before.edges = [];
  before.evidence = [];
  const after = clone(before);
  after.nodes = [record('new', 'Same')];
  const result = compareModels({ before, after });
  assert.deepEqual(result.renameCandidates, []);
  assert.equal(result.nodes.added.length, 1);
  assert.equal(result.nodes.removed.length, 1);
});

test('compareModels reports dangling evidence references instead of repairing them', () => {
  const before = clone(FIXTURE);
  const after = clone(FIXTURE);
  after.evidence = after.evidence.filter((entry) => entry.id !== 'ev.invoice');
  const result = compareModels({ before, after });
  assert.equal(result.ok, true);
  assert.deepEqual(result.danglingEvidenceRefs, [
    { kind: 'edge', id: 'edge.api.invoice', evidenceId: 'ev.invoice' },
    { kind: 'edge', id: 'edge.invoice.db', evidenceId: 'ev.invoice' },
    { kind: 'node', id: 'module.invoice', evidenceId: 'ev.invoice' },
  ]);
  assert.equal(result.identical, false);
});

test('compareModels reports the revision change and never infers it', () => {
  const same = compareModels({ before: FIXTURE, after: clone(FIXTURE) });
  assert.equal(same.revisionChanged, false);
  assert.equal(same.identical, true);

  const moved = clone(FIXTURE);
  moved.sourceRevision = 'ffffffffffffffffffffffffffffffffffffffff';
  const result = compareModels({ before: FIXTURE, after: moved });
  assert.equal(result.revisionChanged, true);
  assert.equal(result.identical, false);

  const unknownRevision = clone(FIXTURE);
  unknownRevision.sourceRevision = null;
  const withNull = compareModels({ before: FIXTURE, after: unknownRevision });
  assert.equal(withNull.revisionChanged, true, 'a known revision differs from an unknown one');
});

test('compareModels is order-insensitive and deterministic', () => {
  const shuffle = (model) => {
    const copy = clone(model);
    copy.nodes.reverse();
    copy.edges.reverse();
    copy.evidence.reverse();
    return copy;
  };
  const first = compareModels({ before: FIXTURE, after: clone(FIXTURE) });
  const shuffled = compareModels({ before: shuffle(FIXTURE), after: shuffle(FIXTURE) });
  assert.deepEqual(shuffled, first);
  assert.deepEqual(compareModels({ before: FIXTURE, after: clone(FIXTURE) }), first);
});

test('compareModels compares the id-only collections without inventing fields', () => {
  const after = clone(FIXTURE);
  after.unknowns.push({ id: 'unknown.retry', question: 'Retry policy?' });
  const result = compareModels({ before: FIXTURE, after });
  const unknowns = result.idCollections.find((entry) => entry.collection === 'unknowns');
  assert.deepEqual(unknowns.added, ['unknown.retry']);
  assert.deepEqual(unknowns.removed, []);
  assert.equal(unknowns.unchanged, 1);
  assert.equal(result.identical, false);
});

test('compareModels rejects a missing side instead of comparing against nothing', () => {
  for (const input of [undefined, null, {}, { before: FIXTURE }, { after: FIXTURE }, { before: 'x', after: FIXTURE }, []]) {
    const result = compareModels(input);
    assert.equal(result.ok, false);
    assert.equal(isKnownCode(result.error.code), true);
  }
});

test('compareModels rejects structurally broken models rather than silently declaring identity', () => {
  const broken = [{}, null, [], { nodes: 'x', edges: 3, evidence: null, views: 'y' }];
  for (const value of broken) {
    const result = compareModels({ before: value, after: value });
    assert.equal(result.ok, false);
    assert.ok([CODES.INVALID_OPTION, CODES.UNSUPPORTED_INPUT].includes(result.error.code));
  }
});

test('comparison rejects duplicate IDs without claiming validation', () => {
  const dirty = clone(FIXTURE);
  dirty.nodes.push({ id: 'module.invoice', name: 'Duplicate', type: 'module', state: 'current', status: 'confirmed', confidence: 'high', evidenceIds: [] });
  assert.equal(validateModel(dirty).valid, false, 'the fixture mutation must actually be invalid');
  const result = compareModels({ before: dirty, after: clone(dirty) });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, CODES.DUPLICATE_ID);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'validation'), false);
});

test('error codes added for query and compare are registered', () => {
  assert.equal(CODES.CHANGE_SOURCE_UNAVAILABLE, 'change_source_unavailable');
  assert.equal(isKnownCode(CODES.CHANGE_SOURCE_UNAVAILABLE), true);
});

test('cycle detection completes an exact node budget and respects relation filters', () => {
  const model = shapeModel();
  model.nodes = model.nodes.slice(0, 3);
  model.edges = model.edges.slice(0, 3);
  model.edges.push({ ...model.edges[0], id: 'ignored', type: 'writes' });
  const result = queryCycles({ model, maxNodes: 3, relationTypes: ['calls'] });
  assert.equal(result.truncated, false);
  assert.equal(result.cycles.length, 1);
  assert.deepEqual(result.cycles[0].edges.map((edge) => edge.id), ['e.ab', 'e.bc', 'e.ca']);
});

test('unknown self-loop is reported but never promoted to a cycle', () => {
  const model = shapeModel();
  model.nodes = model.nodes.slice(0, 1);
  model.edges = [{ ...model.edges[0], target: 'a', type: 'teleports' }];
  const result = queryCycles({ model, maxNodes: 1 });
  assert.deepEqual(result.cycles, []);
  assert.ok(stopReasons(result).includes('unknown_relation_type'));
});

test('queryModel caps edges even when all nodes fit the limit', () => {
  const model = shapeModel();
  model.nodes = model.nodes.slice(0, 2);
  model.edges = Array.from({ length: 6 }, (_, i) => ({ ...model.edges[0], id: `edge.${i}` }));
  const result = queryModel({ model, limit: 2 });
  assert.equal(result.nodes.length, 2);
  assert.equal(result.edges.length, 2);
  assert.equal(result.totalEdges, 6);
  assert.equal(result.truncated, true);
});
