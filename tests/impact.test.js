'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeImpact } = require('../src/core/impact');
const { createGraph } = require('../src/core/graph');
const { CODES } = require('../src/core/error-codes');

function node(id, overrides = {}) {
  return Object.assign({
    id,
    name: id,
    type: 'module',
    state: 'current',
    status: 'inferred',
    confidence: 'low',
    evidenceIds: [],
  }, overrides);
}

function edge(id, source, target, overrides = {}) {
  return Object.assign({
    id,
    source,
    target,
    type: 'depends_on',
    state: 'current',
    status: 'inferred',
    confidence: 'low',
    evidenceIds: [],
  }, overrides);
}

function model(nodes, edges, overrides = {}) {
  return Object.assign({
    schemaVersion: 1,
    project: { id: 'impact' },
    scope: { roots: ['src'] },
    sourceRevision: null,
    generatedAt: '2024-05-01T09:30:00Z',
    coverage: { filesScanned: nodes.length, complete: true },
    nodes,
    edges,
    evidence: [],
  }, overrides);
}

const CHAIN = model([node('a'), node('b'), node('c')], [
  edge('e1', 'a', 'b'),
  edge('e2', 'b', 'c'),
]);

// Compact projection of the traversal result: [nodeId, depth, viaEdgeId].
function trace(result) {
  return result.impacted.map((entry) => [entry.nodeId, entry.depth, entry.via.edgeId]);
}

function reasons(result) {
  return result.stopReasons.map((entry) => entry.reason);
}

function withoutElapsed(result) {
  const clone = JSON.parse(JSON.stringify(result));
  clone.stats.elapsedMs = 0;
  return clone;
}

test('downstream, upstream and both walk the chain in the requested direction', () => {
  const downstream = computeImpact({ model: CHAIN, targets: ['a'] });
  assert.equal(downstream.ok, true);
  assert.deepEqual(trace(downstream), [['b', 1, 'e1'], ['c', 2, 'e2']]);
  assert.deepEqual(downstream.targets, [{ input: 'a', matchedNodeIds: ['a'] }]);
  assert.deepEqual(downstream.unresolvedTargets, []);
  assert.equal(downstream.truncated, false);
  assert.deepEqual(reasons(downstream), ['frontier_exhausted']);
  assert.equal(downstream.stats.visitedNodes, 3);
  assert.equal(downstream.stats.visitedEdges, 2);
  assert.equal(downstream.stats.maxDepthReached, 2);

  const upstream = computeImpact({ model: CHAIN, targets: ['c'], direction: 'upstream' });
  assert.deepEqual(trace(upstream), [['b', 1, 'e2'], ['a', 2, 'e1']]);

  const both = computeImpact({ model: CHAIN, targets: ['b'], direction: 'both' });
  assert.deepEqual(trace(both), [['a', 1, 'e1'], ['c', 1, 'e2']]);
  assert.equal(both.ok, true);

  const seeded = computeImpact({ model: CHAIN, targets: ['b'], direction: 'both' });
  assert.equal(seeded.impacted.some((entry) => entry.nodeId === 'b'), false);
});

test('a caller-supplied graph index is used instead of rebuilding it from the model', () => {
  const fromModel = computeImpact({ model: CHAIN, targets: ['a'] });
  const fromGraph = computeImpact({ graph: createGraph(CHAIN), targets: ['a'], model: null });
  assert.deepEqual(withoutElapsed(fromGraph), withoutElapsed(fromModel));
});

test('relationTypes restricts which edges are followed', () => {
  const mixed = model([node('a'), node('b'), node('c')], [
    edge('e1', 'a', 'b', { type: 'calls' }),
    edge('e2', 'b', 'c', { type: 'depends_on' }),
  ]);

  const callsOnly = computeImpact({ model: mixed, targets: ['a'], relationTypes: ['calls'] });
  assert.deepEqual(trace(callsOnly), [['b', 1, 'e1']]);

  const dependsOnly = computeImpact({ model: mixed, targets: ['a'], relationTypes: ['depends_on'] });
  assert.equal(dependsOnly.ok, true);
  assert.deepEqual(dependsOnly.impacted, []);

  const none = computeImpact({ model: mixed, targets: ['a'], relationTypes: [] });
  assert.deepEqual(none.impacted, []);
  assert.equal(none.ok, true);
  assert.deepEqual(reasons(none), ['frontier_exhausted']);
});

test('maxDepth stops the walk and reports max_depth', () => {
  const result = computeImpact({ model: CHAIN, targets: ['a'], maxDepth: 1 });
  assert.deepEqual(trace(result), [['b', 1, 'e1']]);
  assert.equal(result.truncated, true);
  assert.deepEqual(reasons(result), ['max_depth']);
  const stop = result.stopReasons[0];
  assert.equal(stop.nodeId, 'b');
  assert.match(stop.detail, /1 edge/);
});

test('maxNodes stops the walk and reports max_nodes without counting seeds', () => {
  const fan = model(
    [node('root'), node('x'), node('y'), node('z')],
    [edge('e1', 'root', 'x'), edge('e2', 'root', 'y'), edge('e3', 'root', 'z')],
  );

  const limited = computeImpact({ model: fan, targets: ['root'], maxNodes: 2 });
  assert.deepEqual(trace(limited), [['x', 1, 'e1'], ['y', 1, 'e2']]);
  assert.equal(limited.truncated, true);
  assert.deepEqual(reasons(limited), ['max_nodes']);
  assert.equal(limited.stopReasons[0].nodeId, 'z');

  const one = computeImpact({ model: fan, targets: ['root'], maxNodes: 1 });
  assert.deepEqual(trace(one), [['x', 1, 'e1']]);
  assert.equal(one.truncated, true);
});

test('maxTimeMs stops the walk when the injected clock exceeds the budget', () => {
  const deep = model(
    [node('a'), node('b'), node('c'), node('d')],
    [edge('e1', 'a', 'b'), edge('e2', 'b', 'c'), edge('e3', 'c', 'd')],
  );

  let clock = 0;
  const now = () => {
    clock += 1;
    return clock;
  };

  const result = computeImpact({ model: deep, targets: ['a'], maxTimeMs: 7, now });
  assert.equal(result.ok, true);
  assert.deepEqual(trace(result), [['b', 1, 'e1'], ['c', 2, 'e2']]);
  assert.equal(result.truncated, true);
  assert.deepEqual(reasons(result), ['max_time_budget']);
  assert.equal(result.stopReasons[0].nodeId, 'c');
  assert.equal(typeof result.stats.elapsedMs, 'number');
});

test('a cycle is a stop reason, not an error, and terminates', () => {
  const cycle = model([node('a'), node('b')], [edge('e1', 'a', 'b'), edge('e2', 'b', 'a')]);
  const result = computeImpact({ model: cycle, targets: ['a'] });

  assert.equal(result.ok, true);
  assert.deepEqual(trace(result), [['b', 1, 'e1']]);
  assert.equal(result.truncated, false);
  assert.deepEqual(reasons(result), ['cycle_detected']);
  assert.equal(result.stopReasons[0].nodeId, 'b');
  assert.match(result.stopReasons[0].detail, /already reached/);
});

test('a diamond keeps every node once and prefers the smallest edge id at the smallest depth', () => {
  const diamond = model(
    [node('a'), node('b'), node('c'), node('d')],
    [
      edge('e4', 'c', 'd'),
      edge('e1', 'a', 'b'),
      edge('e3', 'b', 'd'),
      edge('e2', 'a', 'c'),
    ],
  );

  const result = computeImpact({ model: diamond, targets: ['a'] });
  assert.deepEqual(trace(result), [['b', 1, 'e1'], ['c', 1, 'e2'], ['d', 2, 'e3']]);
  assert.equal(result.impacted.filter((entry) => entry.nodeId === 'd').length, 1);
});

test('file-path targets resolve through stable file IDs and declared evidence paths', () => {
  const files = model(
    [
      node('file:src/app.js', { name: 'src/app.js' }),
      node('mod-util', { name: 'Utility', evidenceIds: ['ev-util'] }),
      node('file:a/shared.js', { name: 'Shared A', evidenceIds: ['ev-shared'] }),
      node('file:b/shared.js', { name: 'Shared B', evidenceIds: ['ev-shared'] }),
    ],
    [
      edge('e1', 'file:src/app.js', 'mod-util'),
      edge('e2', 'mod-util', 'file:a/shared.js'),
      edge('e3', 'mod-util', 'file:b/shared.js'),
    ],
    { evidence: [{ id: 'ev-util', path: 'src/util.js', type: 'code' }, { id: 'ev-shared', path: 'shared.js', type: 'code' }] },
  );

  const byPrefix = computeImpact({ model: files, targets: ['src/app.js'] });
  assert.deepEqual(byPrefix.targets, [{ input: 'src/app.js', matchedNodeIds: ['file:src/app.js'] }]);
  assert.deepEqual(trace(byPrefix), [['mod-util', 1, 'e1'], ['file:a/shared.js', 2, 'e2'], ['file:b/shared.js', 2, 'e3']]);

  const byName = computeImpact({ model: files, targets: ['src/util.js'] });
  assert.deepEqual(byName.targets, [{ input: 'src/util.js', matchedNodeIds: ['mod-util'] }]);

  const multiple = computeImpact({ model: files, targets: ['shared.js'] });
  assert.deepEqual(multiple.targets, [{ input: 'shared.js', matchedNodeIds: ['file:a/shared.js', 'file:b/shared.js'] }]);

  const mixed = computeImpact({ model: files, targets: ['src/util.js', 'mod-util', 'src/missing.js'] });
  assert.deepEqual(mixed.targets, [
    { input: 'mod-util', matchedNodeIds: ['mod-util'] },
    { input: 'src/util.js', matchedNodeIds: ['mod-util'] },
  ]);
  assert.deepEqual(mixed.unresolvedTargets.map((entry) => entry.input), ['src/missing.js']);
  assert.equal(typeof mixed.unresolvedTargets[0].reason, 'string');
  assert.notEqual(mixed.unresolvedTargets[0].reason, '');
  assert.equal(mixed.ok, true);
});

test('invalid options produce INVALID_OPTION instead of throwing', () => {
  const invalid = [
    {},
    { targets: undefined },
    { targets: [] },
    { targets: 'a' },
    { targets: ['a', 7] },
    { targets: [null] },
    { targets: ['a'], direction: 'sideways' },
    { targets: ['a'], direction: 1 },
    { targets: ['a'], maxDepth: 0 },
    { targets: ['a'], maxDepth: -1 },
    { targets: ['a'], maxDepth: 1.5 },
    { targets: ['a'], maxDepth: '3' },
    { targets: ['a'], maxNodes: 0 },
    { targets: ['a'], maxNodes: 2.5 },
    { targets: ['a'], maxNodes: null },
    { targets: ['a'], maxTimeMs: 0 },
    { targets: ['a'], maxTimeMs: -5 },
    { targets: ['a'], maxTimeMs: Number.POSITIVE_INFINITY },
    { targets: ['a'], maxTimeMs: '100' },
    { targets: ['a'], now: 42 },
    { targets: ['a'], relationTypes: 'calls' },
    { targets: ['a'], relationTypes: ['calls', 3] },
  ];

  for (const input of invalid) {
    const result = computeImpact(input);
    assert.equal(result.ok, false, `expected ok:false for ${JSON.stringify(input)}`);
    assert.equal(result.error.code, CODES.INVALID_OPTION, `expected invalid_option for ${JSON.stringify(input)}`);
    assert.equal(typeof result.error.message, 'string');
    assert.deepEqual(result.impacted, []);
    assert.deepEqual(result.stopReasons, []);
  }

  const badGraph = computeImpact({ targets: ['a'], graph: 42 });
  assert.equal(badGraph.ok, false);
  assert.equal(badGraph.error.code, CODES.UNSUPPORTED_INPUT);
});

test('malformed inputs never throw and unusable edge endpoints become dangling', () => {
  const malformed = [undefined, null, 42, 'x', [], {}, true, { targets: ['a'], model: null }];

  for (const input of malformed) {
    const result = computeImpact(input);
    assert.equal(typeof result, 'object');
    assert.equal(typeof result.ok, 'boolean');
    assert.ok(Array.isArray(result.targets));
    assert.ok(Array.isArray(result.impacted));
    assert.ok(Array.isArray(result.unresolvedTargets));
    assert.ok(Array.isArray(result.stopReasons));
    assert.ok(Array.isArray(result.dangling));
  }

  assert.equal(computeImpact({ targets: ['a'], model: null }).ok, true);

  const broken = model(
    [node('a'), null, 'not-a-node', { name: 'no-id' }],
    [
      edge('e1', 'a', 'ghost'),
      edge('e2', 'ghost', 'a'),
      edge('e3', 'a', 'a'),
      edge('e4', 'a', 'ghost', { type: 'teleports' }),
      null,
      { id: 'e5' },
    ],
  );

  const result = computeImpact({ model: broken, targets: ['a'] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.dangling, [
    { id: 'e1', reason: 'unknown_target', nodeId: 'ghost' },
    { id: 'e2', reason: 'unknown_source', nodeId: 'ghost' },
    { id: 'e4', reason: 'unknown_target', nodeId: 'ghost' },
    { id: 'e5', reason: 'unknown_source', nodeId: 'undefined' },
    { id: 'e5', reason: 'unknown_target', nodeId: 'undefined' },
  ]);
  assert.deepEqual(result.impacted, []);

  const cyclic = { nodes: [node('a')], edges: [edge('e1', 'a', 'a')], evidence: [] };
  cyclic.self = cyclic;
  const cyclicResult = computeImpact({ model: cyclic, targets: ['a'] });
  assert.equal(cyclicResult.ok, true);
  assert.deepEqual(reasons(cyclicResult), ['cycle_detected']);
});

test('edge types outside the v1 enum stop propagation and are reported', () => {
  const exotic = model(
    [node('a'), node('b'), node('c')],
    [edge('e1', 'a', 'b', { type: 'teleports' }), edge('e2', 'a', 'c')],
  );

  const result = computeImpact({ model: exotic, targets: ['a'] });
  assert.equal(result.ok, true);
  assert.deepEqual(trace(result), [['c', 1, 'e2']]);
  const unknown = result.stopReasons.filter((entry) => entry.reason === 'unknown_relation_type');
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].nodeId, 'a');
  assert.match(unknown[0].detail, /teleports/);
  assert.equal(result.truncated, false);

  const selected = computeImpact({ model: exotic, targets: ['a'], relationTypes: ['teleports'] });
  assert.deepEqual(selected.impacted, []);
  assert.deepEqual(reasons(selected), ['unknown_relation_type']);
});

test('results are deterministic and independent of model array order', () => {
  const graphModel = model(
    [node('a'), node('b'), node('c'), node('d'), node('e')],
    [
      edge('e5', 'd', 'e'),
      edge('e1', 'a', 'b'),
      edge('e3', 'b', 'd'),
      edge('e2', 'a', 'c'),
      edge('e4', 'c', 'd'),
    ],
  );

  const first = withoutElapsed(computeImpact({ model: graphModel, targets: ['a'], direction: 'both' }));
  const second = withoutElapsed(computeImpact({ model: graphModel, targets: ['a'], direction: 'both' }));
  assert.deepEqual(first, second);

  const shuffled = model(
    graphModel.nodes.slice().reverse(),
    graphModel.edges.slice().reverse(),
  );
  const reordered = withoutElapsed(computeImpact({ model: shuffled, targets: ['a'], direction: 'both' }));
  assert.deepEqual(reordered, first);
});

test('the input model is not modified', () => {
  const inputModel = JSON.parse(JSON.stringify(CHAIN));
  inputModel.evidence = [{ id: 'ev1', path: 'src/b.js', type: 'code' }];
  inputModel.nodes[1].evidenceIds = ['ev2', 'ev1'];

  const before = JSON.stringify(inputModel);
  const result = computeImpact({ model: inputModel, targets: ['a'] });
  const after = JSON.stringify(inputModel);

  assert.equal(after, before);
  assert.deepEqual(result.impacted[0].evidenceIds, ['ev1', 'ev2']);
  assert.notEqual(result.impacted[0].evidenceIds, inputModel.nodes[1].evidenceIds);
});

test('default impact clock is deterministic without ambient time', () => {
  const input = { model: CHAIN, targets: ['a'] };
  const first = computeImpact(input);
  assert.equal(first.ok, true);
  assert.equal(first.stats.elapsedMs, 0);
  assert.equal(JSON.stringify(computeImpact(input)), JSON.stringify(first));
});

test('shared nodes at different depths and multiple seeds are not cycles', () => {
  const shared = model([node('a'), node('b'), node('c')], [edge('ab', 'a', 'b'), edge('ac', 'a', 'c'), edge('bc', 'b', 'c')]);
  for (const targets of [['a'], ['a', 'b']]) {
    assert.equal(reasons(computeImpact({ model: shared, targets })).includes('cycle_detected'), false);
  }
  assert.equal(reasons(computeImpact({ model: CHAIN, targets: ['a'], direction: 'both' })).includes('cycle_detected'), false);
  assert.equal(reasons(computeImpact({ model: shared, targets: ['a'], direction: 'both' })).includes('cycle_detected'), false);
});

test('clock is checked before every node admission, including a broad frontier', () => {
  const fan = model([node('a'), node('b'), node('c')], [edge('ab', 'a', 'b'), edge('ac', 'a', 'c')]);
  let calls = 0;
  const result = computeImpact({ model: fan, targets: ['a'], maxTimeMs: 5, now: () => calls++ });
  assert.deepEqual(trace(result), [['b', 1, 'ab']]);
  assert.equal(result.truncated, true);
  assert.ok(reasons(result).includes('max_time_budget'));
});

test('unknown endpoints explain propagation stops', () => {
  const result = computeImpact({ model: model([node('a')], [edge('bad', 'a', 'missing')]), targets: ['a'] });
  assert.deepEqual(reasons(result), ['unknown_endpoint']);
  assert.match(result.stopReasons[0].detail, /missing/);
});

test('change source requests without targets never guess Git changes', () => {
  for (const input of [{ branch: 'main' }, { changeSource: 'git' }]) {
    assert.equal(computeImpact(input).error.code, CODES.CHANGE_SOURCE_UNAVAILABLE);
  }
});

test('controlled failures retain injected exception details', () => {
  const result = computeImpact({ model: CHAIN, targets: ['a'], now() { throw new Error('clock offline'); } });
  assert.equal(result.error.code, CODES.INTERNAL_ERROR);
  assert.equal(result.error.message.includes('clock offline'), false);
});

test('directed cycles remain detectable when traversing both directions', () => {
  const cyclic = model([node('a'), node('b')], [edge('ab', 'a', 'b'), edge('ba', 'b', 'a')]);
  for (const direction of ['upstream', 'downstream', 'both']) {
    const result = computeImpact({ model: cyclic, targets: ['a'], direction });
    assert.ok(reasons(result).includes('cycle_detected'));
    assert.equal(result.impacted.length, 1);
  }
});

test('display name alone cannot establish file identity', () => {
  const input = model([node('x', { name: 'src/not-evidence.js' })], []);
  const result = computeImpact({ model: input, targets: ['src/not-evidence.js'] });
  assert.deepEqual(result.targets, []);
  assert.equal(result.unresolvedTargets.length, 1);
});
