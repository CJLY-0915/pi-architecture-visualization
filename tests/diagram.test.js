'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDiagram } = require('../src/core/diagram');
const fixture = require('../fixtures/valid-minimal-model.json');

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function nodeTag(svg, id) {
  const match = svg.match(new RegExp(`<g class="dg-node" data-node-id="${escapeRegExp(id)}"[^>]*>`));
  return match ? match[0] : '';
}

function edgeTag(svg, source, target) {
  const match = svg.match(new RegExp(`<path class="dg-edge" data-source="${escapeRegExp(source)}" data-target="${escapeRegExp(target)}"[^>]*>`));
  return match ? match[0] : '';
}

function findNode(result, id) { return result.nodes.find((node) => node.id === id); }

// A minimal valid v1 model shell. Nodes use status "inferred" so they need no
// evidence, keeping the local models free of the confirmed-fact rule.
function baseModel() {
  return {
    schemaVersion: 1,
    project: { id: 'test', name: 'Test' },
    scope: { roots: ['.'] },
    sourceRevision: null,
    generatedAt: '2024-05-01T09:30:00Z',
    coverage: { filesScanned: 1, complete: true },
    nodes: [],
    edges: [],
    evidence: [],
    views: [],
    findings: [],
    decisions: [],
    migrationSlices: [],
    unknowns: [],
  };
}

function node(id, extra) {
  return Object.assign({ id, name: id, type: 'system', state: 'current', status: 'inferred', confidence: 'medium', evidenceIds: [] }, extra);
}

function edge(id, source, target) {
  return { id, source, target, type: 'calls', state: 'current', status: 'inferred', confidence: 'medium', evidenceIds: [] };
}

function chainModel() {
  const model = baseModel();
  model.nodes = [node('n.a'), node('n.b'), node('n.c'), node('n.d')];
  model.edges = [edge('e.ab', 'n.a', 'n.b'), edge('e.bc', 'n.b', 'n.c'), edge('e.cd', 'n.c', 'n.d')];
  return model;
}

test('a valid minimal model renders an svg diagram with one node group per node', () => {
  const result = buildDiagram(clone(fixture));
  assert.equal(result.ok, true);
  assert.ok(result.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'), 'the root must be a self-contained svg element');
  assert.match(result.svg, /role="img" aria-label="Architecture relationship diagram"/);
  assert.match(result.svg, /<style>[^]*dg-node \{ cursor: pointer; \}/);
  assert.equal((result.svg.match(/data-node-id=/g) || []).length, fixture.nodes.length, 'one node group per declared node');
  assert.equal((result.svg.match(/<title>/g) || []).length, fixture.nodes.length, 'each node carries a native tooltip title');
  assert.equal(result.nodes.length, fixture.nodes.length);
  for (const entry of result.nodes) {
    assert.deepEqual(Object.keys(entry).sort(), ['depth', 'id', 'name', 'status', 'type']);
  }
  for (const entry of result.edges) {
    assert.deepEqual(Object.keys(entry).sort(), ['id', 'source', 'target', 'type']);
  }
});

test('building the same model twice yields a byte-identical svg string', () => {
  const first = buildDiagram(clone(fixture), { focus: 'container.api' });
  const second = buildDiagram(clone(fixture), { focus: 'container.api' });
  assert.equal(first.svg, second.svg, 'the render is deterministic and must not depend on object identity');
});

test('nodes without a usable parentId land at depth zero and children stack below them', () => {
  const result = buildDiagram(clone(fixture));
  // A missing parentId is a root; validateModel refuses an unknown parentId
  // before layout, so the depth-0 fallback for an undeclared parent is defensive.
  assert.equal(findNode(result, 'sys.billing').depth, 0);
  assert.equal(findNode(result, 'datastore.billingdb').depth, 0);
  assert.equal(findNode(result, 'actor.operator').depth, 0);
  assert.equal(findNode(result, 'container.api').depth, 1);
  assert.equal(findNode(result, 'module.invoice').depth, 2);
  assert.equal(result.layout.layers, 3);
});

test('focus highlights the focus node, its neighbours and the touching edges and dims the rest', () => {
  const result = buildDiagram(clone(fixture), { focus: 'container.api' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.focus, { id: 'container.api', name: 'Billing API', neighbours: ['actor.operator', 'module.invoice'] });
  const svg = result.svg;
  assert.ok(nodeTag(svg, 'container.api').includes('data-emphasis="on"'), 'the focus node is emphasised');
  assert.ok(nodeTag(svg, 'actor.operator').includes('data-emphasis="on"'), 'a neighbour is emphasised');
  assert.ok(nodeTag(svg, 'module.invoice').includes('data-emphasis="on"'), 'a neighbour is emphasised');
  assert.ok(nodeTag(svg, 'sys.billing').includes('data-emphasis="off"'), 'an unrelated node is dimmed');
  assert.ok(nodeTag(svg, 'datastore.billingdb').includes('data-emphasis="off"'), 'an unrelated node is dimmed');
  assert.ok(edgeTag(svg, 'container.api', 'module.invoice').includes('data-emphasis="on"'), 'an edge touching the focus is emphasised');
  assert.ok(edgeTag(svg, 'actor.operator', 'container.api').includes('data-emphasis="on"'), 'an edge touching the focus is emphasised');
  assert.ok(edgeTag(svg, 'module.invoice', 'datastore.billingdb').includes('data-emphasis="off"'), 'an edge not touching the focus is dimmed');
});

test('without a focus every node and edge is emphasised and focus is null', () => {
  const result = buildDiagram(clone(fixture));
  assert.equal(result.focus, null);
  assert.ok(!/<(?:g|path)[^>]*data-emphasis="off"/.test(result.svg), 'no node or edge element is dimmed without a focus (the stylesheet selector is not an element)');
  assert.ok(result.svg.includes('data-emphasis="on"'), 'nodes and edges are emphasised');
});

test('an unknown focus id is refused as an invalid option rather than silently ignored', () => {
  const result = buildDiagram(clone(fixture), { focus: 'nope' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'invalid_option');
  assert.equal(result.svg, undefined, 'a refused focus must not produce a diagram');
});

test('a malformed focus is refused as an invalid option', () => {
  assert.equal(buildDiagram(clone(fixture), { focus: '' }).error.code, 'invalid_option', 'an empty focus is malformed');
  assert.equal(buildDiagram(clone(fixture), { focus: 'x'.repeat(1025) }).error.code, 'invalid_option', 'an over-long focus is malformed');
  assert.equal(buildDiagram(clone(fixture), { focus: 7 }).error.code, 'invalid_option', 'a non-string focus is malformed');
});

test('maxNodes truncation reports the omitted nodes and marks the diagram incomplete', () => {
  const result = buildDiagram(chainModel(), { maxNodes: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.omitted, { nodes: 2, edges: 2 });
  assert.deepEqual(result.nodes.map((entry) => entry.id), ['n.a', 'n.b'], 'only the first nodes in layer order are rendered');
  // Only an edge whose both endpoints were rendered is drawn.
  assert.deepEqual(result.edges, [{ id: 'e.ab', source: 'n.a', target: 'n.b', type: 'calls' }]);
  assert.ok(result.limitations.some((entry) => entry.includes('incomplete') && entry.includes('omitted')), 'truncation is named in the limitations');
});

test('maxEdges truncation reports the omitted edges and keeps every drawable edge available', () => {
  const result = buildDiagram(chainModel(), { maxEdges: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.omitted, { nodes: 0, edges: 2 });
  assert.equal(result.nodes.length, 4, 'no node budget was set so all nodes render');
  assert.equal(result.edges.length, 1, 'only the first edge is rendered');
  assert.ok(result.limitations.some((entry) => entry.includes('incomplete') && entry.includes('omitted')));
});

test('an invalid model is refused with an invalid_model code and never throws', () => {
  const invalid = clone(fixture);
  invalid.nodes[0].id = '';
  let result;
  assert.doesNotThrow(() => { result = buildDiagram(invalid); });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'invalid_model');
  assert.equal(result.validation.valid, false, 'the validation detail is returned like export-preview');
  assert.equal(result.svg, undefined);
});

test('garbage model input never throws and fails closed', () => {
  for (const garbage of [null, 'a string', ['not', 'a', 'model'], 42]) {
    let result;
    assert.doesNotThrow(() => { result = buildDiagram(garbage); }, `garbage ${JSON.stringify(garbage)} must not throw`);
    assert.equal(result.ok, false, `garbage ${JSON.stringify(garbage)} must fail`);
    assert.equal(result.error.code, 'invalid_model');
  }
});

test('a hostile node name cannot break out of the svg markup', () => {
  const model = clone(fixture);
  model.nodes[0].name = '<script>&"\'';
  const result = buildDiagram(model);
  assert.equal(result.ok, true);
  assert.ok(!result.svg.includes('<script'), 'the raw script tag must not survive into the markup');
  assert.ok(result.svg.includes('&lt;script&gt;'), 'the hostile name is escaped in the output');
  assert.ok(result.svg.includes('&amp;&quot;&apos;'), 'every dangerous character is escaped');
});

test('a hostile node id cannot break out of an attribute value', () => {
  const model = baseModel();
  model.nodes = [node('a<b>&"x'), node('plain', { parentId: 'a<b>&"x' })];
  model.edges = [edge('e1', 'a<b>&"x', 'plain')];
  const result = buildDiagram(model);
  assert.equal(result.ok, true);
  assert.ok(!result.svg.includes('a<b>&"x'), 'the raw id must not appear unescaped');
  assert.ok(result.svg.includes('data-node-id="a&lt;b&gt;&amp;&quot;x"'), 'the id is escaped inside the attribute');
  assert.ok(result.svg.includes('data-source="a&lt;b&gt;&amp;&quot;x"'), 'the edge source is escaped inside the attribute');
});

test('the renderer never mutates its input model', () => {
  const model = clone(fixture);
  const before = clone(fixture);
  buildDiagram(model, { focus: 'container.api', maxNodes: 3, maxEdges: 2 });
  assert.deepEqual(model, before, 'buildDiagram is pure and must not mutate its input');
});

test('invalid budgets are refused as invalid options and the boundaries are accepted', () => {
  assert.equal(buildDiagram(clone(fixture), { maxNodes: 0 }).error.code, 'invalid_option');
  assert.equal(buildDiagram(clone(fixture), { maxNodes: 2001 }).error.code, 'invalid_option');
  assert.equal(buildDiagram(clone(fixture), { maxEdges: 1.5 }).error.code, 'invalid_option');
  assert.equal(buildDiagram(clone(fixture), { maxNodes: '10' }).error.code, 'invalid_option');
  assert.equal(buildDiagram(clone(fixture), { maxNodes: 1 }).ok, true, 'the lower bound is inclusive');
  assert.equal(buildDiagram(clone(fixture), { maxEdges: 2000 }).ok, true, 'the upper bound is inclusive');
});

test('the default budget and layout geometry are reported in the result', () => {
  const result = buildDiagram(clone(fixture));
  assert.deepEqual(result.layout.maxNodes, 120);
  assert.deepEqual(result.layout.maxEdges, 240);
  assert.equal(typeof result.layout.width, 'number');
  assert.equal(typeof result.layout.height, 'number');
  assert.ok(result.layout.width > 0 && result.layout.height > 0, 'the canvas has a positive size');
  assert.match(result.svg, new RegExp(`width="${result.layout.width}" height="${result.layout.height}" viewBox="0 0 ${result.layout.width} ${result.layout.height}"`));
});

test('limitations is always a non-empty array of strings on the success path', () => {
  const result = buildDiagram(clone(fixture));
  assert.ok(Array.isArray(result.limitations) && result.limitations.length > 0);
  for (const entry of result.limitations) assert.equal(typeof entry, 'string');
  assert.ok(result.limitations.some((entry) => entry.includes('parentId') && entry.includes('measured runtime topology') && entry.includes('no source file was read')));
});

test('limitations is a non-empty array of strings on the failure path', () => {
  const invalid = clone(fixture);
  invalid.nodes[0].id = '';
  for (const result of [buildDiagram(invalid), buildDiagram(null), buildDiagram(clone(fixture), { focus: 'nope' })]) {
    assert.equal(result.ok, false);
    assert.ok(Array.isArray(result.limitations) && result.limitations.length > 0, 'a failed render still states its limitations');
    for (const entry of result.limitations) assert.equal(typeof entry, 'string');
  }
});
