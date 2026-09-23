'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGraph, traverse, queryPaths, queryCycles, queryNeighbours, normalizeOptions } = require('../src/core/query');
const { CODES, isKnownCode } = require('../src/core/error-codes');

function model(ids, pairs) {
  return {
    nodes: ids.map((id) => ({ id, type: 'module', evidenceIds: ['proof'] })),
    edges: pairs.map(([source, target, type = 'calls'], i) => ({ id: `e${i}`, source, target, type, evidenceIds: ['proof'] })),
    evidence: [{ id: 'proof', type: 'code', path: 'src/a.js' }],
  };
}
const hasStop = (result, reason) => result.stops.some((stop) => stop.reason === reason);

function assertLoop(loop, direction) {
  assert.equal(new Set(loop.nodeIds).size, loop.nodeIds.length);
  assert.equal(loop.edges.length, loop.nodeIds.length);
  assert.equal(new Set(loop.edges.map((edge) => edge.id)).size, loop.edges.length);
  assert.equal(loop.isDefect, null);
  loop.edges.forEach((edge, i) => {
    const from = loop.nodeIds[i];
    const to = loop.nodeIds[(i + 1) % loop.nodeIds.length];
    if (direction === 'downstream') assert.deepEqual([edge.source, edge.target], [from, to]);
    else if (direction === 'upstream') assert.deepEqual([edge.target, edge.source], [from, to]);
    else assert.ok((edge.source === from && edge.target === to) || (edge.target === from && edge.source === to));
    assert.equal(edge.evidence[0].id, 'proof');
    assert.equal(loop.nodes[i].evidence[0].id, 'proof');
  });
}

test('traverse does not call a shared diamond node a cycle', () => {
  const graph = createGraph(model(['a', 'b', 'c', 'd'], [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']]));
  const result = traverse(graph, ['a', 'a']);
  assert.deepEqual(result.impacted.map((node) => node.nodeId), ['b', 'c', 'd']);
  assert.equal(hasStop(result, 'cycle_detected'), false);
  assert.equal(result.truncated, false);
});

test('traverse enforces admission budget on a star and handles exact budget', () => {
  const graph = createGraph(model(['a', 'b', 'c', 'd'], [['a', 'b'], ['a', 'c'], ['a', 'd']]));
  const limited = traverse(graph, ['a'], { maxNodes: 2 });
  assert.equal(limited.impacted.length, 2);
  assert.equal(limited.stats.visitedNodes, 2);
  assert.equal(hasStop(limited, 'max_nodes'), true);
  assert.equal(limited.truncated, true);
  assert.equal(traverse(graph, ['a'], { maxNodes: 3 }).truncated, false);
});

test('traverse seed back-edge closes a real path without impacting the seed', () => {
  const graph = createGraph(model(['a', 'b'], [['a', 'b'], ['b', 'a'], ['b', 'ghost']]));
  const result = traverse(graph, ['a'], { maxNodes: 1 });
  assert.deepEqual(result.impacted.map((node) => node.nodeId), ['b']);
  assert.equal(hasStop(result, 'cycle_detected'), true);
  assert.equal(hasStop(result, 'unsupported_input'), true);
  assert.equal(result.truncated, false);
});

test('paths bound all admitted candidates on a dense graph', () => {
  const ids = Array.from({ length: 30 }, (_, i) => `n${String(i).padStart(2, '0')}`);
  const pairs = ids.flatMap((source) => ids.filter((target) => target !== source).map((target) => [source, target]));
  const result = queryPaths({ model: model(ids, pairs), from: ids[0], to: ids[29], maxNodes: 7, maxDepth: 5 });
  assert.equal(result.ok, true);
  assert.ok(result.stats.visitedNodes <= 7);
  assert.equal(hasStop(result, 'max_nodes'), true);
  assert.equal(result.truncated, true);
  assert.ok(result.paths.length <= 6);
});

test('paths complete exact budgets and never admit unknown endpoints or relation evidence', () => {
  const clean = model(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]);
  const exact = queryPaths({ model: clean, from: 'a', to: 'c', maxNodes: 3, maxDepth: 2 });
  assert.equal(exact.truncated, false);
  assert.equal(exact.paths.length, 1);
  const dirty = model(['a', 'b', 'c'], [['a', 'ghost'], ['a', 'c', 'teleports'], ['a', 'b'], ['b', 'c']]);
  const result = queryPaths({ model: dirty, from: 'a', to: 'c' });
  assert.equal(hasStop(result, 'unknown_relation_type'), true);
  assert.equal(hasStop(result, 'unsupported_input'), true);
  assert.deepEqual(result.paths[0].map((step) => step.nodeId), ['a', 'b', 'c']);
  assert.deepEqual(result.paths[0].slice(1).map((step) => step.via.edgeId), ['e2', 'e3']);
});

test('cycles sharing a node are separate ordered simple loops, not one SCC', () => {
  const input = model(['a', 'b', 'c', 'd', 'e'], [['a', 'b'], ['b', 'c'], ['c', 'a'], ['a', 'd'], ['d', 'e'], ['e', 'a'], ['a', 'c', 'teleports']]);
  for (const direction of ['downstream', 'upstream', 'both']) {
    const result = queryCycles({ model: input, direction, maxDepth: 5 });
    assert.equal(result.cycles.length, 2);
    assert.equal(new Set(result.cycles.map((cycle) => cycle.id)).size, 2);
    for (const loop of result.cycles) {
      assertLoop(loop, direction);
      assert.equal(loop.edges.some((edge) => edge.type === 'teleports'), false);
    }
  }
});

test('both-direction cycles require distinct edges, including parallel edges and self-loops', () => {
  assert.deepEqual(queryCycles({ model: model(['a', 'b'], [['a', 'b']]), direction: 'both' }).cycles, []);
  const parallel = queryCycles({ model: model(['a', 'b'], [['a', 'b'], ['a', 'b']]), direction: 'both' });
  assert.equal(parallel.cycles.length, 1);
  assertLoop(parallel.cycles[0], 'both');
  const self = queryCycles({ model: model(['a'], [['a', 'a']]), direction: 'both', maxDepth: 1, maxNodes: 1, maxCycles: 1 });
  assert.equal(self.cycles.length, 1);
  assert.equal(self.truncated, false);
  assertLoop(self.cycles[0], 'both');
});

test('cycle depth, node and cycle-count budgets have explicit reasons and exact limits complete', () => {
  const ring = model(['a', 'b', 'c'], [['a', 'b'], ['b', 'c'], ['c', 'a']]);
  const exact = queryCycles({ model: ring, maxNodes: 3, maxDepth: 3, maxCycles: 1 });
  assert.equal(exact.truncated, false);
  assert.equal(exact.cycles.length, 1);
  const shallow = queryCycles({ model: ring, maxDepth: 2 });
  assert.deepEqual(shallow.cycles, []);
  assert.equal(hasStop(shallow, 'max_depth'), true);
  const limited = queryCycles({ model: ring, maxNodes: 2 });
  assert.equal(limited.stats.visitedNodes, 2);
  assert.equal(hasStop(limited, 'max_nodes'), true);
  const two = queryCycles({ model: model(['a', 'b'], [['a', 'a'], ['b', 'b']]), maxCycles: 1 });
  assert.equal(two.cycles.length, 1);
  assert.equal(two.truncated, true);
  assert.equal(hasStop(two, 'max_cycles'), true);
});

test('neighbour budgets and unknown seeds are explicit', () => {
  const input = model(['a', 'b', 'c'], [['a', 'b'], ['a', 'c']]);
  const limited = queryNeighbours({ model: input, targets: ['a'], maxNodes: 1 });
  assert.equal(limited.neighbours.length, 1);
  assert.equal(limited.truncated, true);
  assert.equal(hasStop(limited, 'max_nodes'), true);
  assert.equal(queryNeighbours({ model: input, targets: ['a'], maxNodes: 2 }).truncated, false);
  assert.equal(queryNeighbours({ model: input, targets: ['ghost'] }).error.code, CODES.UNKNOWN_NODE);
});

test('query time budgets use only injected time, with a deterministic default', () => {
  const input = model(['a', 'b'], [['a', 'b'], ['b', 'a']]);
  const runs = [
    (options) => traverse(createGraph(input), ['a'], options),
    (options) => queryNeighbours({ model: input, targets: ['a'], ...options }),
    (options) => queryPaths({ model: input, from: 'a', to: 'b', ...options }),
    (options) => queryCycles({ model: input, ...options }),
  ];
  for (const run of runs) {
    assert.equal(run({}).stats.elapsedMs, 0);
    let time = 0;
    const timed = run({ maxTimeMs: 1, now: () => (time += 2) });
    assert.equal(timed.truncated, true);
    assert.equal(hasStop(timed, 'max_time_budget'), true);
  }
});

test('option failures and diagnostics use registered codes', () => {
  for (const options of [{ now: 7 }, { maxNodes: 0 }, { maxDepth: -1 }, { maxTimeMs: NaN }, { types: ['nope'] }]) {
    const normalized = normalizeOptions(options);
    assert.equal(normalized.ok, false);
    assert.ok(normalized.errors.every((error) => isKnownCode(error.code)));
  }
  for (const maxCycles of [0, -1, 100001, 1.5]) {
    const result = queryCycles({ maxCycles });
    assert.equal(result.ok, false);
    assert.equal(isKnownCode(result.error.code), true);
  }
});

test('layered acyclic graphs stop after exactly maxSteps candidate edges', () => {
  const layers = Array.from({ length: 16 }, (_, i) => Array.from({ length: 4 }, (_, j) => `n${String(i).padStart(2, '0')}.${j}`));
  const pairs = layers.slice(0, -1).flatMap((layer, i) => layer.flatMap((from) => layers[i + 1].map((to) => [from, to])));
  const input = model(layers.flat(), pairs);
  const result = queryCycles({ model: input, maxDepth: 30, maxSteps: 20 });
  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
  assert.equal(hasStop(result, 'max_steps'), true);
  assert.equal(result.stats.steps, 20);
  assert.equal(result.stats.visitedEdges, 20);
  assert.deepEqual(result.cycles, []);
  const defaults = queryCycles({ model: input, maxDepth: 30 });
  assert.equal(defaults.stats.steps, 10000);
  assert.equal(hasStop(defaults, 'max_steps'), true);
});

test('step budgets are exact across traversal queries and validate limits', () => {
  const input = model(['a', 'b', 'c'], [['a', 'b'], ['a', 'c']]);
  const runs = [
    (options) => traverse(createGraph(input), ['a'], options),
    (options) => queryNeighbours({ model: input, targets: ['a'], direction: 'downstream', ...options }),
    (options) => queryPaths({ model: input, from: 'a', to: 'c', ...options }),
    (options) => queryCycles({ model: input, ...options }),
  ];
  for (const run of runs) {
    const exact = run({ maxSteps: 2 });
    assert.equal(exact.truncated, false);
    assert.equal(exact.stats.steps, 2);
    const cut = run({ maxSteps: 1 });
    assert.equal(cut.truncated, true);
    assert.equal(hasStop(cut, 'max_steps'), true);
    assert.equal(cut.stats.steps, 1);
    for (const maxSteps of [0, -1, 1.5, 100001, Infinity]) {
      assert.equal(run({ maxSteps }).error.code, CODES.INVALID_OPTION);
    }
  }
  const self = queryCycles({ model: model(['a'], [['a', 'a']]), maxCycles: 1, maxSteps: 1 });
  assert.equal(self.truncated, false);
  assert.equal(self.cycles.length, 1);
});

test('non-finite clock values fail explicitly, including after the first tick', () => {
  const input = model(['a', 'b'], [['a', 'b']]);
  const runs = [
    (now) => traverse(createGraph(input), ['a'], { now }),
    (now) => queryNeighbours({ model: input, targets: ['a'], now }),
    (now) => queryPaths({ model: input, from: 'a', to: 'b', now }),
    (now) => queryCycles({ model: input, now }),
  ];
  for (const run of runs) {
    for (const bad of [NaN, Infinity, -Infinity, '0', undefined]) {
      for (const validFirst of [false, true]) {
        let ticks = 0;
        const result = run(() => validFirst && ticks++ === 0 ? 0 : bad);
        assert.equal(result.ok, false);
        assert.equal(result.error.code, CODES.INVALID_OPTION);
        assert.equal(result.error.path, 'options.now');
      }
    }
  }
});

test('isolated-node traversal loops still check injected time', () => {
  const input = model(['a', 'b', 'c'], []);
  for (const run of [
    (now) => traverse(createGraph(input), ['a', 'b', 'c'], { now, maxTimeMs: 1 }),
    (now) => queryNeighbours({ model: input, targets: ['a', 'b', 'c'], now, maxTimeMs: 1 }),
    (now) => queryCycles({ model: input, now, maxTimeMs: 1 }),
  ]) {
    let ticks = 0;
    const result = run(() => ticks++ * 2);
    assert.equal(result.truncated, true);
    assert.equal(hasStop(result, 'max_time_budget'), true);
    assert.equal(result.stats.steps, 0);
  }
});
