'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { validateModel, SUPPORTED_SCHEMA_VERSION, ENUMS, COLLECTIONS } = require('../src/core/validation');
const { CODES, CODE_MESSAGES, isKnownCode } = require('../src/core/error-codes');

const { ID_COLLECTIONS, GENERIC_ID_COLLECTIONS } = COLLECTIONS;
const ROOT_DIR = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT_DIR, 'fixtures');
const SCHEMA_PATH = path.join(ROOT_DIR, 'schemas', 'architecture-model.schema.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readFixture(name) {
  return readJson(path.join(FIXTURE_DIR, name));
}

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

function evidenceEntry(id, evidencePath, overrides = {}) {
  return Object.assign({ id, path: evidencePath, type: 'code' }, overrides);
}

function minimalModel(overrides = {}) {
  return Object.assign({
    schemaVersion: 1,
    project: { id: 'sample' },
    scope: { roots: ['src'] },
    sourceRevision: null,
    generatedAt: '2024-05-01T09:30:00Z',
    coverage: { filesScanned: 0, complete: true },
    nodes: [],
    edges: [],
    evidence: [],
    views: [],
    findings: [],
    decisions: [],
    migrationSlices: [],
    unknowns: [],
  }, overrides);
}

function pairs(result) {
  return result.diagnostics.map((diagnostic) => `${diagnostic.code} @ ${diagnostic.path}`);
}

function minimalModelWithout(name) {
  const model = minimalModel();
  delete model[name];
  return model;
}

function assertValid(model) {
  const result = validateModel(model);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.valid, true);
  return result;
}

test('valid-minimal-model fixture passes with the frozen contract', () => {
  const model = readFixture('valid-minimal-model.json');
  const result = validateModel(model);

  assert.equal(result.valid, true);
  assert.equal(result.schemaVersion, SUPPORTED_SCHEMA_VERSION);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.summary, { nodes: 5, edges: 3, evidence: 3 });
  assert.deepEqual(Object.keys(result).sort(), ['diagnostics', 'schemaVersion', 'summary', 'valid']);
});

test('invalid-dangling-edge fixture fails only on the dangling target', () => {
  const result = validateModel(readFixture('invalid-dangling-edge.json'));

  assert.equal(result.valid, false);
  assert.deepEqual(pairs(result), ['dangling_edge_endpoint @ edges[1].target']);
  assert.match(result.diagnostics[0].message, /datastore\.ledger/);
  assert.deepEqual(result.summary, { nodes: 5, edges: 3, evidence: 3 });
});

test('invalid-unproven-fact fixture fails only on the unproven confirmed node', () => {
  const result = validateModel(readFixture('invalid-unproven-fact.json'));

  assert.equal(result.valid, false);
  assert.deepEqual(pairs(result), ['unproven_confirmed_fact @ nodes[1].evidenceIds']);
  assert.match(result.diagnostics[0].message, /container\.api/);
});

test('validateModel never throws and always returns the result shape', () => {
  const nested = { schemaVersion: 1, project: { id: 'p' }, nodes: [[{ id: 'n' }]] };
  const inputs = [
    undefined, null, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '', '   ', 'model',
    true, false, [], [1, 2, [3]], {}, { schemaVersion: 1 }, nested, () => {}, new Date(0),
    { schemaVersion: 1, project: null, scope: [], nodes: null, edges: 'x' },
  ];

  for (const input of inputs) {
    const result = validateModel(input);
    assert.equal(typeof result.valid, 'boolean', `valid flag for ${String(input)}`);
    assert.ok(Array.isArray(result.diagnostics));
    assert.equal(result.diagnostics.length > 0, result.valid === false);
    assert.equal(typeof result.summary.nodes, 'number');
    assert.equal(typeof result.summary.edges, 'number');
    assert.equal(typeof result.summary.evidence, 'number');
    for (const diagnostic of result.diagnostics) {
      assert.equal(typeof diagnostic.code, 'string');
      assert.equal(typeof diagnostic.path, 'string');
      assert.ok(diagnostic.message.length > 0);
      assert.ok(isKnownCode(diagnostic.code), `unknown diagnostic code ${diagnostic.code}`);
    }
  }
});

test('validateModel reports internal_error instead of throwing on hostile input', () => {
  const hostile = {};
  Object.defineProperty(hostile, 'schemaVersion', { get() { throw new Error('boom'); } });

  const result = validateModel(hostile);

  assert.equal(result.valid, false);
  assert.deepEqual(pairs(result), ['internal_error @ ']);
  assert.doesNotMatch(result.diagnostics[0].message, /boom/);
});

test('schemaVersion must be the integer 1', () => {
  assert.deepEqual(pairs(validateModel({})), ['missing_required_field @ schemaVersion']);

  const stringVersion = validateModel(minimalModel({ schemaVersion: '1' }));
  assert.deepEqual(pairs(stringVersion), ['invalid_schema_version @ schemaVersion']);
  assert.equal(stringVersion.schemaVersion, null);

  assert.deepEqual(pairs(validateModel(minimalModel({ schemaVersion: 1.5 }))), ['invalid_schema_version @ schemaVersion']);
  assert.deepEqual(pairs(validateModel(minimalModel({ schemaVersion: null }))), ['invalid_schema_version @ schemaVersion']);
  assert.deepEqual(pairs(validateModel(minimalModel({ schemaVersion: true }))), ['invalid_schema_version @ schemaVersion']);

  for (const version of [0, 2, 3, 99]) {
    const result = validateModel(minimalModel({ schemaVersion: version }));
    assert.deepEqual(pairs(result), ['unsupported_schema_version @ schemaVersion']);
    assert.equal(result.schemaVersion, version);
    assert.equal(result.diagnostics.length, 1);
  }
});

test('project must be an object with a non-empty id', () => {
  assert.deepEqual(pairs(validateModel(minimalModelWithout('project'))), ['missing_required_field @ project']);
  assert.deepEqual(pairs(validateModel(minimalModel({ project: null }))), ['invalid_type @ project']);
  assert.deepEqual(pairs(validateModel(minimalModel({ project: [] }))), ['invalid_type @ project']);
  assert.deepEqual(pairs(validateModel(minimalModel({ project: { name: 'x' } }))), ['missing_required_field @ project.id']);
  assert.deepEqual(pairs(validateModel(minimalModel({ project: { id: '' } }))), ['empty_string @ project.id']);
  assert.deepEqual(pairs(validateModel(minimalModel({ project: { id: '   ' } }))), ['empty_string @ project.id']);
  assert.deepEqual(pairs(validateModel(minimalModel({ project: { id: 7 } }))), ['invalid_type @ project.id']);
  assertValid(minimalModel({ project: { id: 'sample', name: 'Sample', owner: 'team' } }));
});

test('scope.roots must be a non-empty list of relative POSIX paths', () => {
  assert.deepEqual(pairs(validateModel(minimalModelWithout('scope'))), ['missing_required_field @ scope']);
  assert.deepEqual(pairs(validateModel(minimalModel({ scope: 'src' }))), ['invalid_type @ scope']);
  assert.deepEqual(pairs(validateModel(minimalModel({ scope: {} }))), ['missing_required_field @ scope.roots']);
  assert.deepEqual(pairs(validateModel(minimalModel({ scope: { roots: 'src' } }))), ['invalid_type @ scope.roots']);
  assert.deepEqual(pairs(validateModel(minimalModel({ scope: { roots: [] } }))), ['invalid_scope_root @ scope.roots']);

  const rejected = ['/abs/path', 'C:\\repo', 'C:/repo', 'src\\app', '../src', 'src/', 'src//app', 'src/../app', 5, null, ''];
  for (const root of rejected) {
    const result = validateModel(minimalModel({ scope: { roots: [root] } }));
    assert.deepEqual(pairs(result), ['invalid_scope_root @ scope.roots[0]'], `root ${JSON.stringify(root)}`);
  }

  assertValid(minimalModel({ scope: { roots: ['.'] } }));
  assertValid(minimalModel({ scope: { roots: ['./src'] } }));
  assertValid(minimalModel({ scope: { roots: ['src', 'docs'] } }));

  const secondBad = validateModel(minimalModel({ scope: { roots: ['src', '..'] } }));
  assert.deepEqual(pairs(secondBad), ['invalid_scope_root @ scope.roots[1]']);
});

test('sourceRevision is required, nullable and never empty', () => {
  assert.deepEqual(pairs(validateModel(minimalModelWithout('sourceRevision'))), ['missing_required_field @ sourceRevision']);
  assertValid(minimalModel({ sourceRevision: null }));
  assertValid(minimalModel({ sourceRevision: 'abc123' }));
  assert.deepEqual(pairs(validateModel(minimalModel({ sourceRevision: '' }))), ['empty_string @ sourceRevision']);
  assert.deepEqual(pairs(validateModel(minimalModel({ sourceRevision: 123 }))), ['invalid_type @ sourceRevision']);
  assert.deepEqual(pairs(validateModel(minimalModel({ sourceRevision: {} }))), ['invalid_type @ sourceRevision']);
});

test('generatedAt must be an ISO 8601 date-time with timezone', () => {
  assert.deepEqual(pairs(validateModel(minimalModelWithout('generatedAt'))), ['missing_required_field @ generatedAt']);

  const invalid = ['not-a-date', '2024-05-01', '2024-05-01T09:30:00', '2024-13-01T00:00:00Z', '2024-05-01T09:30:00+99:00', 1714555800000, null];
  for (const generatedAt of invalid) {
    assert.deepEqual(pairs(validateModel(minimalModel({ generatedAt }))), ['invalid_iso_datetime @ generatedAt'], String(generatedAt));
  }

  assertValid(minimalModel({ generatedAt: '2024-05-01T09:30:00Z' }));
  assertValid(minimalModel({ generatedAt: '2024-05-01T09:30:00.123Z' }));
  assertValid(minimalModel({ generatedAt: '2024-05-01T09:30:00+08:00' }));
});

test('coverage requires a non-negative integer and a boolean', () => {
  assert.deepEqual(pairs(validateModel(minimalModelWithout('coverage'))), ['missing_required_field @ coverage']);
  assert.deepEqual(pairs(validateModel(minimalModel({ coverage: [] }))), ['invalid_type @ coverage']);
  assert.deepEqual(pairs(validateModel(minimalModel({ coverage: { complete: true } }))), ['missing_required_field @ coverage.filesScanned']);
  assert.deepEqual(pairs(validateModel(minimalModel({ coverage: { complete: true, filesScanned: -1 } }))), ['invalid_non_negative_integer @ coverage.filesScanned']);
  assert.deepEqual(pairs(validateModel(minimalModel({ coverage: { complete: true, filesScanned: 1.5 } }))), ['invalid_non_negative_integer @ coverage.filesScanned']);
  assert.deepEqual(pairs(validateModel(minimalModel({ coverage: { complete: true, filesScanned: '3' } }))), ['invalid_non_negative_integer @ coverage.filesScanned']);
  assert.deepEqual(pairs(validateModel(minimalModel({ coverage: { filesScanned: 0 } }))), ['missing_required_field @ coverage.complete']);
  assert.deepEqual(pairs(validateModel(minimalModel({ coverage: { filesScanned: 0, complete: 'yes' } }))), ['invalid_type @ coverage.complete']);
  assertValid(minimalModel({ coverage: { filesScanned: 0, complete: false, truncated: true } }));
});

test('every collection is required and must be an array', () => {
  for (const name of ID_COLLECTIONS) {
    const missing = minimalModel();
    delete missing[name];
    const result = validateModel(missing);
    assert.deepEqual(pairs(result), [`missing_required_field @ ${name}`], name);
    assert.equal(result.summary.nodes, 0);
  }

  for (const name of ['nodes', 'edges', 'evidence', 'views', 'findings', 'decisions', 'migrationSlices', 'unknowns']) {
    const result = validateModel(minimalModel({ [name]: {} }));
    assert.deepEqual(pairs(result), [`invalid_type @ ${name}`], name);
  }

  assert.deepEqual(pairs(validateModel(minimalModel({ nodes: ['n1'] }))), ['invalid_type @ nodes[0]']);
  assert.deepEqual(pairs(validateModel(minimalModel({ edges: [null] }))), ['invalid_type @ edges[0]']);
  assert.deepEqual(pairs(validateModel(minimalModel({ evidence: [42] }))), ['invalid_type @ evidence[0]']);
});

test('summary reports array lengths and stays zero for unusable collections', () => {
  const model = minimalModel({
    nodes: [node('n1'), node('n2')],
    edges: [edge('e1', 'n1', 'n2')],
    evidence: [evidenceEntry('ev.a', 'src/a.js')],
  });

  assert.deepEqual(validateModel(model).summary, { nodes: 2, edges: 1, evidence: 1 });
  assert.deepEqual(validateModel(minimalModel({ nodes: {}, edges: 'x', evidence: null })).summary, { nodes: 0, edges: 0, evidence: 0 });
  assert.deepEqual(validateModel(null).summary, { nodes: 0, edges: 0, evidence: 0 });
});

test('node ids must be unique per collection', () => {
  const duplicateNodes = minimalModel({ nodes: [node('n1'), node('n1')] });
  assert.deepEqual(pairs(validateModel(duplicateNodes)), ['duplicate_id @ nodes[1].id']);

  const duplicateEdges = minimalModel({
    nodes: [node('n1'), node('n2')],
    edges: [edge('e1', 'n1', 'n2'), edge('e1', 'n1', 'n2')],
  });
  assert.deepEqual(pairs(validateModel(duplicateEdges)), ['duplicate_id @ edges[1].id']);

  const duplicateEvidence = minimalModel({
    evidence: [evidenceEntry('ev.a', 'src/a.js'), evidenceEntry('ev.a', 'src/b.js')],
  });
  assert.deepEqual(pairs(validateModel(duplicateEvidence)), ['duplicate_id @ evidence[1].id']);

  const duplicateViews = minimalModel({ views: [{ id: 'v1' }, { id: 'v1' }] });
  assert.deepEqual(pairs(validateModel(duplicateViews)), ['duplicate_id @ views[1].id']);

  const duplicateUnknowns = minimalModel({ unknowns: [{ id: 'u1' }, { id: 'u1' }] });
  assert.deepEqual(pairs(validateModel(duplicateUnknowns)), ['duplicate_id @ unknowns[1].id']);
});

test('node and edge ids live in separate namespaces', () => {
  const model = minimalModel({
    nodes: [node('shared'), node('n2')],
    edges: [edge('shared', 'shared', 'n2')],
  });
  assertValid(model);
});

test('node fields are validated against the v1 contract', () => {
  assert.deepEqual(pairs(validateModel(minimalModel({ nodes: [{ id: 'n1' }] }))), [
    'missing_required_field @ nodes[0].name',
    'missing_required_field @ nodes[0].type',
    'missing_required_field @ nodes[0].state',
    'missing_required_field @ nodes[0].status',
    'missing_required_field @ nodes[0].confidence',
    'missing_required_field @ nodes[0].evidenceIds',
  ]);

  assert.deepEqual(pairs(validateModel(minimalModel({ nodes: [node('n1', { name: '' })] }))), ['empty_string @ nodes[0].name']);
  assert.deepEqual(pairs(validateModel(minimalModel({ nodes: [node('n1', { id: 5 })] }))), ['invalid_type @ nodes[0].id']);

  for (const type of ['service', 'MODULE', '', 7, null]) {
    assert.deepEqual(pairs(validateModel(minimalModel({ nodes: [node('n1', { type })] }))), ['invalid_enum_value @ nodes[0].type'], String(type));
  }
  for (const state of ['planned', 'CURRENT', 1]) {
    assert.deepEqual(pairs(validateModel(minimalModel({ nodes: [node('n1', { state })] }))), ['invalid_enum_value @ nodes[0].state'], String(state));
  }
  for (const status of ['verified', 'CONFIRMED', 0]) {
    assert.deepEqual(pairs(validateModel(minimalModel({ nodes: [node('n1', { status })] }))), ['invalid_enum_value @ nodes[0].status'], String(status));
  }
  for (const confidence of ['very-high', 'HIGH', {}]) {
    assert.deepEqual(pairs(validateModel(minimalModel({ nodes: [node('n1', { confidence })] }))), ['invalid_enum_value @ nodes[0].confidence'], String(confidence));
  }

  for (const allowed of ENUMS.NODE_TYPES) {
    assertValid(minimalModel({ nodes: [node('n1', { type: allowed })] }));
  }
  for (const allowed of ENUMS.STATUSES) {
    const evidenceIds = allowed === 'confirmed' ? ['ev.a'] : [];
    assertValid(minimalModel({
      nodes: [node('n1', { status: allowed, evidenceIds })],
      evidence: [evidenceEntry('ev.a', 'src/a.js')],
    }));
  }

  assert.deepEqual(pairs(validateModel(minimalModel({ nodes: [node('n1', { parentId: '' })] }))), ['empty_string @ nodes[0].parentId']);
  assert.deepEqual(pairs(validateModel(minimalModel({ nodes: [node('n1', { parentId: 3 })] }))), ['invalid_type @ nodes[0].parentId']);
});

test('edge fields are validated against the v1 contract', () => {
  assert.deepEqual(pairs(validateModel(minimalModel({
    nodes: [node('n1'), node('n2')],
    edges: [{ id: 'e1' }],
  }))), [
    'missing_required_field @ edges[0].source',
    'missing_required_field @ edges[0].target',
    'missing_required_field @ edges[0].type',
    'missing_required_field @ edges[0].state',
    'missing_required_field @ edges[0].status',
    'missing_required_field @ edges[0].confidence',
    'missing_required_field @ edges[0].evidenceIds',
  ]);

  for (const type of ['uses', 'DEPENDS_ON', '', 1]) {
    assert.deepEqual(pairs(validateModel(minimalModel({
      nodes: [node('n1'), node('n2')],
      edges: [edge('e1', 'n1', 'n2', { type })],
    }))), ['invalid_enum_value @ edges[0].type'], String(type));
  }
  for (const allowed of ENUMS.RELATION_TYPES) {
    assertValid(minimalModel({ nodes: [node('n1'), node('n2')], edges: [edge('e1', 'n1', 'n2', { type: allowed })] }));
  }
  assert.deepEqual(pairs(validateModel(minimalModel({
    nodes: [node('n1'), node('n2')],
    edges: [edge('e1', 'n1', 'n2', { confidence: 'certain' })],
  }))), ['invalid_enum_value @ edges[0].confidence']);
});

test('dangling edge endpoints are rejected with the failing field path', () => {
  const nodes = [node('n1'), node('n2')];

  assert.deepEqual(pairs(validateModel(minimalModel({ nodes, edges: [edge('e1', 'ghost', 'n2')] }))), ['dangling_edge_endpoint @ edges[0].source']);
  assert.deepEqual(pairs(validateModel(minimalModel({ nodes, edges: [edge('e1', 'n1', 'ghost')] }))), ['dangling_edge_endpoint @ edges[0].target']);
  assert.deepEqual(pairs(validateModel(minimalModel({ nodes, edges: [edge('e1', 'ghost', 'ghost')] }))), [
    'dangling_edge_endpoint @ edges[0].source',
    'dangling_edge_endpoint @ edges[0].target',
  ]);

  const missingSource = minimalModel({ nodes, edges: [{ id: 'e1', target: 'n2', type: 'calls', state: 'current', status: 'inferred', confidence: 'low', evidenceIds: [] }] });
  assert.deepEqual(pairs(validateModel(missingSource)), ['missing_required_field @ edges[0].source']);

  const emptySource = minimalModel({ nodes, edges: [edge('e1', '', 'n2')] });
  assert.deepEqual(pairs(validateModel(emptySource)), ['empty_string @ edges[0].source']);

  const numericSource = minimalModel({ nodes, edges: [edge('e1', 5, 'n2')] });
  assert.deepEqual(pairs(validateModel(numericSource)), ['invalid_type @ edges[0].source']);
});

test('edge state must match both endpoint states', () => {
  const mismatched = minimalModel({
    nodes: [node('n1', { state: 'current' }), node('n2', { state: 'target' })],
    edges: [edge('e1', 'n1', 'n2', { state: 'current' })],
  });
  assert.deepEqual(pairs(validateModel(mismatched)), ['edge_state_mismatch @ edges[0].state']);

  const runtimeMismatch = minimalModel({
    nodes: [node('n1', { state: 'current' }), node('n2', { state: 'runtime' })],
    edges: [edge('e1', 'n1', 'n2', { state: 'target' })],
  });
  assert.deepEqual(pairs(validateModel(runtimeMismatch)), ['edge_state_mismatch @ edges[0].state']);

  assertValid(minimalModel({
    nodes: [node('n1', { state: 'runtime' }), node('n2', { state: 'runtime' })],
    edges: [edge('e1', 'n1', 'n2', { state: 'runtime' })],
  }));
  assertValid(minimalModel({
    nodes: [node('n1', { state: 'target' }), node('n2', { state: 'target' })],
    edges: [edge('e1', 'n1', 'n2', { state: 'target' })],
  }));

  const dangling = minimalModel({
    nodes: [node('n1', { state: 'current' })],
    edges: [edge('e1', 'n1', 'ghost', { state: 'target' })],
  });
  assert.deepEqual(pairs(validateModel(dangling)), ['dangling_edge_endpoint @ edges[0].target']);

  const unusableNodeState = minimalModel({
    nodes: [node('n1', { state: 'legacy' }), node('n2')],
    edges: [edge('e1', 'n1', 'n2')],
  });
  assert.deepEqual(pairs(validateModel(unusableNodeState)), ['invalid_enum_value @ nodes[0].state']);
});

test('confirmed facts must resolve to declared evidence', () => {
  assert.deepEqual(pairs(validateModel(minimalModel({ nodes: [node('n1', { status: 'confirmed' })] }))), [
    'unproven_confirmed_fact @ nodes[0].evidenceIds',
  ]);

  assert.deepEqual(pairs(validateModel(minimalModel({ nodes: [node('n1', { status: 'confirmed', evidenceIds: ['ev.missing'] })] }))), [
    'unknown_evidence_reference @ nodes[0].evidenceIds[0]',
    'unproven_confirmed_fact @ nodes[0].evidenceIds',
  ]);

  assertValid(minimalModel({
    nodes: [node('n1', { status: 'confirmed', confidence: 'high', evidenceIds: ['ev.a'] })],
    evidence: [evidenceEntry('ev.a', 'src/a.js')],
  }));

  assertValid(minimalModel({ nodes: [node('n1', { status: 'inferred' })] }));
  assertValid(minimalModel({ nodes: [node('n1', { status: 'unknown' })] }));

  assert.deepEqual(pairs(validateModel(minimalModel({
    nodes: [node('n1'), node('n2')],
    edges: [edge('e1', 'n1', 'n2', { status: 'confirmed' })],
  }))), ['unproven_confirmed_fact @ edges[0].evidenceIds']);

  assertValid(minimalModel({
    nodes: [node('n1'), node('n2')],
    edges: [edge('e1', 'n1', 'n2', { status: 'confirmed', confidence: 'high', evidenceIds: ['ev.a'] })],
    evidence: [evidenceEntry('ev.a', 'src/a.js')],
  }));
});

test('evidenceIds entries must be non-empty strings that resolve', () => {
  const missing = minimalModel({ nodes: [{ id: 'n1', name: 'n1', type: 'module', state: 'current', status: 'inferred', confidence: 'low' }] });
  assert.deepEqual(pairs(validateModel(missing)), ['missing_required_field @ nodes[0].evidenceIds']);

  assert.deepEqual(pairs(validateModel(minimalModel({ nodes: [node('n1', { evidenceIds: 'ev.a' })] }))), ['invalid_type @ nodes[0].evidenceIds']);
  assert.deepEqual(pairs(validateModel(minimalModel({ nodes: [node('n1', { evidenceIds: [''] })] }))), ['empty_string @ nodes[0].evidenceIds[0]']);
  assert.deepEqual(pairs(validateModel(minimalModel({ nodes: [node('n1', { evidenceIds: [5] })] }))), ['invalid_type @ nodes[0].evidenceIds[0]']);
  assert.deepEqual(pairs(validateModel(minimalModel({ nodes: [node('n1', { evidenceIds: ['ev.a'] })] }))), ['unknown_evidence_reference @ nodes[0].evidenceIds[0]']);
  assert.deepEqual(pairs(validateModel(minimalModel({
    nodes: [node('n1'), node('n2')],
    edges: [edge('e1', 'n1', 'n2', { evidenceIds: ['ev.a'] })],
  }))), ['unknown_evidence_reference @ edges[0].evidenceIds[0]']);
});

test('evidence paths must be relative POSIX paths inside the scope roots', () => {
  const rejected = ['/etc/passwd', 'C:\\secret.txt', 'C:/secret.txt', 'src\\main.js', 'src//main.js', 'src/../secret.txt', '../secret.txt', 'src/./main.js', './src/main.js', 'src/main.js/', '', 5, null];
  for (const evidencePath of rejected) {
    const result = validateModel(minimalModel({ evidence: [evidenceEntry('ev.a', evidencePath)] }));
    assert.deepEqual(pairs(result), ['invalid_evidence_path @ evidence[0].path'], JSON.stringify(evidencePath));
  }

  assert.deepEqual(pairs(validateModel(minimalModel({
    scope: { roots: ['src'] },
    evidence: [evidenceEntry('ev.a', 'docs/readme.md')],
  }))), ['evidence_out_of_scope @ evidence[0].path']);

  assert.deepEqual(pairs(validateModel(minimalModel({
    scope: { roots: ['src'] },
    evidence: [evidenceEntry('ev.a', 'src2/main.js')],
  }))), ['evidence_out_of_scope @ evidence[0].path']);

  assertValid(minimalModel({ scope: { roots: ['src'] }, evidence: [evidenceEntry('ev.a', 'src/main.js')] }));
  assertValid(minimalModel({ scope: { roots: ['src'] }, evidence: [evidenceEntry('ev.a', 'src')] }));
  assertValid(minimalModel({ scope: { roots: ['./src'] }, evidence: [evidenceEntry('ev.a', 'src/main.js')] }));
  assertValid(minimalModel({ scope: { roots: ['src', 'docs'] }, evidence: [evidenceEntry('ev.a', 'docs/readme.md')] }));
  assertValid(minimalModel({ scope: { roots: ['.'] }, evidence: [evidenceEntry('ev.a', 'README.md')] }));

  const secondOutOfScope = validateModel(minimalModel({
    scope: { roots: ['src'] },
    evidence: [evidenceEntry('ev.a', 'src/a.js'), evidenceEntry('ev.b', 'README.md')],
  }));
  assert.deepEqual(pairs(secondOutOfScope), ['evidence_out_of_scope @ evidence[1].path']);
});

test('evidence type and optional line are validated', () => {
  assert.deepEqual(pairs(validateModel(minimalModel({ evidence: [{ id: 'ev.a', path: 'src/a.js' }] }))), ['missing_required_field @ evidence[0].type']);
  for (const type of ['yaml', 'CODE', '', 7, null]) {
    assert.deepEqual(pairs(validateModel(minimalModel({ evidence: [evidenceEntry('ev.a', 'src/a.js', { type })] }))), ['invalid_enum_value @ evidence[0].type'], String(type));
  }
  for (const allowed of ENUMS.EVIDENCE_TYPES) {
    assertValid(minimalModel({ evidence: [evidenceEntry('ev.a', 'src/a.js', { type: allowed })] }));
  }

  for (const line of [0, -1, 2.5, '12', null, true]) {
    assert.deepEqual(pairs(validateModel(minimalModel({ evidence: [evidenceEntry('ev.a', 'src/a.js', { line })] }))), ['invalid_positive_integer @ evidence[0].line'], String(line));
  }
  assertValid(minimalModel({ evidence: [evidenceEntry('ev.a', 'src/a.js', { line: 1 })] }));
  assertValid(minimalModel({ evidence: [evidenceEntry('ev.a', 'src/a.js')] }));
  assertValid(minimalModel({ evidence: [evidenceEntry('ev.a', 'src/a.js', { line: 42, symbol: 'load()' })] }));
});

test('parentId must resolve and must not form a hierarchy cycle', () => {
  const unknownParent = minimalModel({ nodes: [node('n1'), node('n2', { parentId: 'ghost' })] });
  assert.deepEqual(pairs(validateModel(unknownParent)), ['unknown_parent_node @ nodes[1].parentId']);

  const selfParent = minimalModel({ nodes: [node('n1', { parentId: 'n1' })] });
  const selfResult = validateModel(selfParent);
  assert.deepEqual(pairs(selfResult), ['hierarchy_cycle @ nodes[0].parentId']);
  assert.match(selfResult.diagnostics[0].message, /n1 -> n1/);

  const twoNodeCycle = minimalModel({ nodes: [node('n1', { parentId: 'n2' }), node('n2', { parentId: 'n1' })] });
  const twoNodeResult = validateModel(twoNodeCycle);
  assert.deepEqual(pairs(twoNodeResult), ['hierarchy_cycle @ nodes[0].parentId']);
  assert.match(twoNodeResult.diagnostics[0].message, /n1 -> n2 -> n1/);

  const cycleBehindEntry = minimalModel({
    nodes: [node('n0'), node('n1', { parentId: 'n2' }), node('n2', { parentId: 'n3' }), node('n3', { parentId: 'n2' })],
  });
  const entryResult = validateModel(cycleBehindEntry);
  assert.deepEqual(pairs(entryResult), ['hierarchy_cycle @ nodes[2].parentId']);
  assert.match(entryResult.diagnostics[0].message, /n2 -> n3 -> n2/);

  assertValid(minimalModel({ nodes: [node('n1'), node('n2', { parentId: 'n1' }), node('n3', { parentId: 'n1' }), node('n4', { parentId: 'n2' })] }));
});

test('views, findings, decisions, migrationSlices and unknowns require unique ids', () => {
  assert.deepEqual(pairs(validateModel(minimalModel({ views: [{ title: 'no id' }] }))), ['missing_required_field @ views[0].id']);
  assert.deepEqual(pairs(validateModel(minimalModel({ views: ['v1'] }))), ['invalid_type @ views[0]']);
  assert.deepEqual(pairs(validateModel(minimalModel({ views: [{ id: '' }] }))), ['empty_string @ views[0].id']);
  assert.deepEqual(pairs(validateModel(minimalModel({ findings: [{ id: 5 }] }))), ['invalid_type @ findings[0].id']);
  assert.deepEqual(pairs(validateModel(minimalModel({ decisions: [{ id: 'd1' }, { id: 'd1' }] }))), ['duplicate_id @ decisions[1].id']);
  assert.deepEqual(pairs(validateModel(minimalModel({ migrationSlices: [null] }))), ['invalid_type @ migrationSlices[0]']);
  assert.deepEqual(pairs(validateModel(minimalModel({ unknowns: [{ id: 'u1' }, {}] }))), ['missing_required_field @ unknowns[1].id']);

  for (const name of GENERIC_ID_COLLECTIONS) {
    assertValid(minimalModel({ [name]: [{ id: 'x', extra: { nested: true } }] }));
  }
});

test('unknown extra fields are tolerated for forward compatibility', () => {
  const model = readFixture('valid-minimal-model.json');
  model.futureField = { anything: [1, 2, 3] };
  model.nodes[0].owner = 'team-billing';
  model.edges[0].protocol = 'https';
  model.evidence[0].fingerprint = 'sha256:abc';

  assertValid(model);
});

test('diagnostics are deterministic, ordered and do not mutate the input', () => {
  const model = minimalModel({
    nodes: [node('dup'), node('dup', { status: 'confirmed' }), node('n3', { parentId: 'ghost', state: 'legacy' })],
    edges: [edge('e1', 'dup', 'ghost', { status: 'confirmed' })],
    evidence: [evidenceEntry('ev.a', 'README.md')],
    views: [{ id: 'v1' }, { id: 'v1' }],
  });
  const snapshot = JSON.stringify(model);

  const first = validateModel(model);
  const second = validateModel(model);
  const cloned = validateModel(JSON.parse(JSON.stringify(model)));

  assert.equal(JSON.stringify(model), snapshot);
  assert.deepEqual(first.diagnostics, second.diagnostics);
  assert.deepEqual(first.diagnostics, cloned.diagnostics);
  assert.notEqual(first.diagnostics, second.diagnostics);
  assert.equal(first.valid, false);
  assert.deepEqual(pairs(first), [
    'duplicate_id @ views[1].id',
    'evidence_out_of_scope @ evidence[0].path',
    'duplicate_id @ nodes[1].id',
    'unproven_confirmed_fact @ nodes[1].evidenceIds',
    'invalid_enum_value @ nodes[2].state',
    'dangling_edge_endpoint @ edges[0].target',
    'unproven_confirmed_fact @ edges[0].evidenceIds',
    'unknown_parent_node @ nodes[2].parentId',
  ]);
});

test('a JSON round-trip of the valid fixture stays valid', () => {
  const model = readFixture('valid-minimal-model.json');
  const result = validateModel(JSON.parse(JSON.stringify(model)));
  assert.equal(result.valid, true);
  assert.deepEqual(result.diagnostics, []);
});

test('every emitted diagnostic code is registered and documented', () => {
  const codeValues = Object.values(CODES);
  assert.equal(new Set(codeValues).size, codeValues.length);
  for (const code of codeValues) {
    assert.match(code, /^[a-z][a-z0-9_]*$/);
    assert.equal(typeof CODE_MESSAGES[code], 'string');
    assert.ok(CODE_MESSAGES[code].length > 0);
    assert.equal(isKnownCode(code), true);
  }
  assert.equal(isKnownCode('not_a_real_code'), false);
  assert.equal(isKnownCode(undefined), false);

  const faultyModels = [
    readFixture('invalid-dangling-edge.json'),
    readFixture('invalid-unproven-fact.json'),
    minimalModel({ nodes: [node('n1', { state: 'legacy' }), node('n1')] }),
    minimalModel({ scope: { roots: ['/abs'] }, evidence: [evidenceEntry('ev.a', '../x')] }),
    minimalModel({ schemaVersion: 3 }),
    null,
  ];
  for (const model of faultyModels) {
    for (const diagnostic of validateModel(model).diagnostics) {
      assert.ok(isKnownCode(diagnostic.code), `unregistered code ${diagnostic.code}`);
    }
  }
});

test('schema document and validator expose the same v1 contract', () => {
  const schema = readJson(SCHEMA_PATH);
  const model = readFixture('valid-minimal-model.json');

  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.type, 'object');
  assert.equal(schema.properties.schemaVersion.const, SUPPORTED_SCHEMA_VERSION);
  assert.deepEqual(schema.properties.project.required, ['id']);
  assert.deepEqual(schema.properties.scope.required, ['roots']);
  assert.equal(schema.properties.scope.properties.roots.minItems, 1);
  assert.deepEqual(schema.properties.sourceRevision.type, ['string', 'null']);
  assert.deepEqual(schema.properties.coverage.required, ['filesScanned', 'complete']);
  assert.equal(schema.properties.coverage.properties.filesScanned.minimum, 0);
  assert.equal(schema.properties.coverage.properties.complete.type, 'boolean');

  assert.deepEqual(schema.$defs.node.required, ['id', 'name', 'type', 'state', 'status', 'confidence', 'evidenceIds']);
  assert.deepEqual(schema.$defs.node.properties.type.enum, ENUMS.NODE_TYPES);
  assert.deepEqual(schema.$defs.node.properties.state.enum, ENUMS.STATES);
  assert.deepEqual(schema.$defs.node.properties.status.enum, ENUMS.STATUSES);
  assert.deepEqual(schema.$defs.node.properties.confidence.enum, ENUMS.CONFIDENCES);

  assert.deepEqual(schema.$defs.edge.required, ['id', 'source', 'target', 'type', 'state', 'status', 'confidence', 'evidenceIds']);
  assert.deepEqual(schema.$defs.edge.properties.type.enum, ENUMS.RELATION_TYPES);
  assert.deepEqual(schema.$defs.edge.properties.state.enum, ENUMS.STATES);
  assert.deepEqual(schema.$defs.edge.properties.status.enum, ENUMS.STATUSES);
  assert.deepEqual(schema.$defs.edge.properties.confidence.enum, ENUMS.CONFIDENCES);

  assert.deepEqual(schema.$defs.evidence.required, ['id', 'path', 'type']);
  assert.deepEqual(schema.$defs.evidence.properties.type.enum, ENUMS.EVIDENCE_TYPES);
  assert.equal(schema.$defs.evidence.properties.line.minimum, 1);
  assert.equal(schema.$defs.evidence.properties.line.type, 'integer');

  assert.deepEqual(schema.required, [
    'schemaVersion', 'project', 'scope', 'sourceRevision', 'generatedAt', 'coverage',
    'nodes', 'edges', 'evidence', 'views', 'findings', 'decisions', 'migrationSlices', 'unknowns',
  ]);
  assert.deepEqual(schema.required.filter((name) => ID_COLLECTIONS.includes(name)), ID_COLLECTIONS);

  for (const name of schema.required) {
    assert.ok(Object.prototype.hasOwnProperty.call(model, name), `fixture is missing ${name}`);
  }
});

test('assumptions remain distinct and confirmed runtime claims require runtime evidence', () => {
  const model = minimalModel({
    nodes: [node('a', { status: 'assumed' }), node('b', { status: 'assumed' })],
    edges: [edge('ab', 'a', 'b', { status: 'assumed' })],
    evidence: [evidenceEntry('ev', 'src/trace.json')],
  });
  assert.equal(validateModel(model).valid, true);
  for (const item of [...model.nodes, ...model.edges]) {
    item.state = 'runtime';
    item.status = 'confirmed';
    item.evidenceIds = ['ev'];
  }
  const result = validateModel(model);
  assert.equal(result.valid, false);
  assert.equal(result.diagnostics.filter(d => d.code === CODES.UNPROVEN_CONFIRMED_FACT).length, 3);
  model.evidence[0].type = 'runtime';
  assert.equal(validateModel(model).valid, true);
});

test('unexpected thrown values cannot break or leak through the failure handler', () => {
  const failure = Object.create(null);
  Object.defineProperty(failure, 'message', { get() { throw new Error('sensitive detail'); } });
  const input = {};
  Object.defineProperty(input, 'schemaVersion', { get() { throw failure; } });
  const result = validateModel(input);
  assert.equal(result.valid, false);
  assert.equal(result.diagnostics[0].code, CODES.INTERNAL_ERROR);
  assert.ok(!JSON.stringify(result).includes('sensitive'));
});
