'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { healthCheck, CATEGORIES } = require('../src/core/health');
const { validateModel } = require('../src/core/validation');
const { CODES, CODE_MESSAGES, isKnownCode } = require('../src/core/error-codes');

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures');
const RESULT_KEYS = ['counts', 'findings', 'limitations', 'model', 'ok', 'unverified', 'validation'];
const VALIDATION_KEYS = ['diagnostics', 'schemaVersion', 'summary', 'valid'];
const SEVERITIES = ['error', 'warning', 'info'];

// Mirrors the conflict protocol documented in src/core/health.js; kept explicit
// here so a silent reclassification of a validator code fails the suite.
const CONFLICT_CODES = [
  CODES.DANGLING_EDGE_ENDPOINT,
  CODES.UNKNOWN_EVIDENCE_REFERENCE,
  CODES.UNPROVEN_CONFIRMED_FACT,
  CODES.EDGE_STATE_MISMATCH,
  CODES.UNKNOWN_PARENT_NODE,
  CODES.HIERARCHY_CYCLE,
  CODES.DUPLICATE_ID,
];

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
}

function node(id, overrides = {}) {
  return Object.assign({
    id,
    name: id,
    type: 'module',
    state: 'current',
    status: 'inferred',
    confidence: 'medium',
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
    confidence: 'medium',
    evidenceIds: [],
  }, overrides);
}

function evidenceEntry(id, evidencePath, overrides = {}) {
  return Object.assign({ id, path: evidencePath, type: 'code' }, overrides);
}

function baseModel(overrides = {}) {
  return Object.assign({
    schemaVersion: 1,
    project: { id: 'sample' },
    scope: { roots: ['src'] },
    sourceRevision: null,
    generatedAt: '2024-05-01T09:30:00Z',
    coverage: { filesScanned: 3, complete: true },
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

// A model with no contract, coverage, unknown, evidence or confidence gap.
function cleanModel() {
  return baseModel({
    nodes: [
      node('module.a', { status: 'confirmed', confidence: 'high', evidenceIds: ['ev.a'] }),
      node('module.b', { status: 'confirmed', confidence: 'high', evidenceIds: ['ev.b'] }),
    ],
    edges: [
      edge('edge.a.b', 'module.a', 'module.b', { status: 'confirmed', confidence: 'high', evidenceIds: ['ev.a'] }),
    ],
    evidence: [evidenceEntry('ev.a', 'src/a.js'), evidenceEntry('ev.b', 'src/b.js')],
  });
}

function codesOf(result) {
  return result.findings.map((item) => `${item.code} @ ${item.kind}:${item.id === null ? '-' : item.id}.${item.field === null ? '-' : item.field}`);
}

function byCode(result, code) {
  return result.findings.filter((item) => item.code === code);
}

function assertStableShape(result) {
  assert.deepEqual(Object.keys(result).sort(), RESULT_KEYS);
  assert.equal(typeof result.ok, 'boolean');
  assert.equal(result.ok, result.validation.valid);
  assert.deepEqual(Object.keys(result.validation).sort(), VALIDATION_KEYS);
  assert.ok(Array.isArray(result.findings));
  assert.ok(Array.isArray(result.limitations));
  assert.ok(result.limitations.length > 0);
  assert.deepEqual(Object.keys(result.counts.byCategory).sort(), [...CATEGORIES].sort());
  assert.equal(result.counts.findings, result.findings.length);
  assert.equal(result.counts.errors + result.counts.warnings + result.counts.infos, result.findings.length);
  assert.equal(Object.values(result.counts.byCategory).reduce((total, value) => total + value, 0), result.findings.length);
  assert.equal(result.unverified.sourceContentVerified, false);
  assert.equal(result.unverified.evidenceFreshness, 'unknown');
  assert.equal(result.unverified.artifactFreshness, 'unknown');
  assert.ok(Array.isArray(result.unverified.reasons));
  assert.equal(result.unverified.reasons.length, 3);

  const sorted = [...result.findings].sort((left, right) => (left.code < right.code ? -1 : left.code > right.code ? 1 : 0));
  assert.deepEqual(result.findings.map((item) => item.code), sorted.map((item) => item.code));

  for (const item of result.findings) {
    assert.ok(isKnownCode(item.code), `unregistered diagnostic code "${item.code}"`);
    assert.ok(CATEGORIES.includes(item.category), `unknown category "${item.category}"`);
    assert.ok(SEVERITIES.includes(item.severity), `unknown severity "${item.severity}"`);
    assert.equal(typeof item.kind, 'string');
    assert.ok(item.id === null || typeof item.id === 'string');
    assert.ok(item.field === null || typeof item.field === 'string');
    assert.ok(typeof item.message === 'string' && item.message.length > 0);
  }
}

test('valid-minimal-model fixture is contract-valid yet reports every declared gap', () => {
  const model = readFixture('valid-minimal-model.json');
  const result = healthCheck(model);

  assertStableShape(result);
  assert.equal(result.ok, true);
  assert.equal(result.validation.valid, true);
  assert.deepEqual(result.validation.diagnostics, []);

  assert.deepEqual(codesOf(result), [
    'coverage_incomplete @ model:-.coverage.complete',
    'declared_unknown @ unknown:unknown.db.ownership.question',
    'low_confidence_fact @ node:datastore.billingdb.confidence',
    'missing_evidence @ edge:edge.operator.api.evidenceIds',
    'missing_evidence @ node:actor.operator.evidenceIds',
    'missing_evidence @ node:datastore.billingdb.evidenceIds',
    'unknown_confidence_fact @ edge:edge.operator.api.confidence',
    'unknown_confidence_fact @ node:actor.operator.confidence',
  ]);

  assert.deepEqual(result.counts, {
    findings: 8,
    errors: 0,
    warnings: 7,
    infos: 1,
    byCategory: { contract: 0, conflicts: 0, coverage: 1, unknowns: 1, evidence: 3, confidence: 3 },
  });

  assert.deepEqual(result.model, {
    projectId: 'sample-billing',
    schemaVersion: 1,
    generatedAt: '2024-05-01T09:30:00Z',
    sourceRevision: 'b7c1f2a9d4e5f60718293a4b5c6d7e8f90123456',
    coverage: { filesScanned: 42, complete: false },
  });
  assert.equal(byCode(result, CODES.COVERAGE_INCOMPLETE)[0].severity, 'warning');
  assert.equal(byCode(result, CODES.DECLARED_UNKNOWN)[0].severity, 'info');
});

test('a model without gaps produces no findings', () => {
  const result = healthCheck(cleanModel());

  assertStableShape(result);
  assert.equal(result.ok, true);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.counts, {
    findings: 0,
    errors: 0,
    warnings: 0,
    infos: 0,
    byCategory: { contract: 0, conflicts: 0, coverage: 0, unknowns: 0, evidence: 0, confidence: 0 },
  });
});

test('healthCheck is deterministic and ignores collection order', () => {
  const model = baseModel({
    nodes: [
      node('module.b', { confidence: 'low', evidenceIds: ['ev.a'] }),
      node('module.a', { status: 'unknown', confidence: 'unknown' }),
    ],
    edges: [edge('edge.a.b', 'module.a', 'module.b')],
    evidence: [evidenceEntry('ev.a', 'src/a.js')],
    unknowns: [
      { id: 'u.1', question: 'Who owns a?' },
      { id: 'u.2', question: 'Who owns b?' },
    ],
  });
  const reordered = baseModel({
    nodes: [
      node('module.a', { status: 'unknown', confidence: 'unknown' }),
      node('module.b', { confidence: 'low', evidenceIds: ['ev.a'] }),
    ],
    edges: [edge('edge.a.b', 'module.a', 'module.b')],
    evidence: [evidenceEntry('ev.a', 'src/a.js')],
    unknowns: [
      { id: 'u.2', question: 'Who owns b?' },
      { id: 'u.1', question: 'Who owns a?' },
    ],
  });

  const first = healthCheck(model);
  const second = healthCheck(model);
  const shuffled = healthCheck(reordered);

  assertStableShape(first);
  assert.deepEqual(first, second);
  assert.deepEqual(shuffled.findings, first.findings);
  assert.deepEqual(shuffled.counts, first.counts);
  assert.deepEqual(codesOf(first), [
    'declared_unknown @ unknown:u.1.question',
    'declared_unknown @ unknown:u.2.question',
    'low_confidence_fact @ node:module.b.confidence',
    'missing_evidence @ edge:edge.a.b.evidenceIds',
    'missing_evidence @ node:module.a.evidenceIds',
    'unknown_confidence_fact @ node:module.a.confidence',
  ]);
});

test('healthCheck never throws and always returns the stable result shape', () => {
  const hostileProxy = new Proxy({}, {
    get() { throw new Error('hostile get'); },
    ownKeys() { throw new Error('hostile ownKeys'); },
    getOwnPropertyDescriptor() { throw new Error('hostile descriptor'); },
  });
  const hostileCoverage = baseModel();
  Object.defineProperty(hostileCoverage, 'coverage', {
    get() { throw new Error('hostile coverage'); },
    enumerable: true,
  });
  const hostileUnknowns = baseModel();
  Object.defineProperty(hostileUnknowns, 'unknowns', {
    get() { throw new Error('hostile unknowns'); },
    enumerable: true,
  });
  const inputs = [
    undefined, null, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '', '   ', 'model',
    [], [1, 2], true, false, () => {}, Object.create(null), { nodes: 'x' },
    { schemaVersion: 2, nodes: [], edges: [], evidence: [] },
    hostileProxy, hostileCoverage, hostileUnknowns,
  ];

  inputs.forEach((input, index) => {
    const result = healthCheck(input);
    assertStableShape(result);
    assert.equal(result.ok, false, `expected ok=false for input #${index}`);
    assert.equal(result.validation.valid, false);
    assert.ok(result.validation.diagnostics.length > 0);
    assert.ok(result.counts.errors > 0);
  });

  assert.deepEqual(codesOf(healthCheck(undefined)), ['model_not_object @ model:-.-']);
  assert.deepEqual(codesOf(healthCheck({ schemaVersion: 2, nodes: [], edges: [], evidence: [] })),
    ['unsupported_schema_version @ model:-.schemaVersion']);
  assert.deepEqual(codesOf(healthCheck(hostileProxy)),
    [`${CODES.INTERNAL_ERROR} @ model:-.-`]);
  assert.deepEqual(codesOf(healthCheck(hostileCoverage)),
    [`${CODES.INTERNAL_ERROR} @ model:-.-`]);
});

test('healthCheck does not mutate its input and accepts a frozen model', () => {
  const model = readFixture('valid-minimal-model.json');
  const before = JSON.stringify(model);

  function deepFreeze(value) {
    if (value === null || typeof value !== 'object') return value;
    Object.getOwnPropertyNames(value).forEach((key) => deepFreeze(value[key]));
    return Object.freeze(value);
  }

  deepFreeze(model);
  const result = healthCheck(model);

  assertStableShape(result);
  assert.equal(JSON.stringify(model), before);
  assert.notEqual(result.model, model.project);
  assert.equal(result.findings.length, 8);
});

test('validator diagnostics are carried verbatim and split into contract and conflicts', () => {
  const model = readFixture('invalid-dangling-edge.json');
  const result = healthCheck(model);

  assertStableShape(result);
  assert.equal(result.ok, false);
  assert.deepEqual(result.validation.diagnostics, validateModel(model).diagnostics);
  assert.deepEqual(byCode(result, CODES.DANGLING_EDGE_ENDPOINT).map((item) => ({
    code: item.code,
    category: item.category,
    severity: item.severity,
    kind: item.kind,
    id: item.id,
    field: item.field,
  })), [{
    code: CODES.DANGLING_EDGE_ENDPOINT,
    category: 'conflicts',
    severity: 'error',
    kind: 'edge',
    id: 'edge.invoice.db',
    field: 'target',
  }]);

  const conflictDiagnostics = result.validation.diagnostics.filter((item) => CONFLICT_CODES.includes(item.code));
  assert.equal(result.counts.byCategory.conflicts, conflictDiagnostics.length);
  assert.equal(result.counts.byCategory.contract, result.validation.diagnostics.length - conflictDiagnostics.length);
  assert.equal(result.counts.errors, result.validation.diagnostics.length);
  assert.match(byCode(result, CODES.DANGLING_EDGE_ENDPOINT)[0].message, /datastore\.ledger/);
});

test('a confirmed fact without evidence is reported as a conflict on its node id', () => {
  const result = healthCheck(readFixture('invalid-unproven-fact.json'));

  assertStableShape(result);
  const conflicts = byCode(result, CODES.UNPROVEN_CONFIRMED_FACT);
  assert.deepEqual(conflicts.map((item) => [item.category, item.severity, item.kind, item.id, item.field]), [
    ['conflicts', 'error', 'node', 'container.api', 'evidenceIds'],
  ]);
  assert.deepEqual(byCode(result, CODES.MISSING_EVIDENCE).map((item) => `${item.kind}:${item.id}`),
    ['edge:edge.operator.api', 'node:actor.operator', 'node:container.api', 'node:datastore.billingdb']);
  assert.equal(result.counts.errors, 1);
});

test('a dangling evidence reference is reported as a conflict on the referencing fact', () => {
  const model = baseModel({
    nodes: [node('module.a', { evidenceIds: ['ev.missing'] })],
  });
  const result = healthCheck(model);

  assertStableShape(result);
  assert.deepEqual(byCode(result, CODES.UNKNOWN_EVIDENCE_REFERENCE).map((item) => ({
    category: item.category,
    severity: item.severity,
    kind: item.kind,
    id: item.id,
    field: item.field,
  })), [{
    category: 'conflicts',
    severity: 'error',
    kind: 'node',
    id: 'module.a',
    field: 'evidenceIds[0]',
  }]);
  assert.equal(byCode(result, CODES.MISSING_EVIDENCE).length, 0);
});

test('hierarchy cycles and duplicate ids stay conflicts keyed by the declared id', () => {
  const cyclic = baseModel({
    nodes: [
      node('module.a', { parentId: 'module.b' }),
      node('module.b', { parentId: 'module.a' }),
    ],
  });
  const cycleResult = healthCheck(cyclic);
  assertStableShape(cycleResult);
  assert.deepEqual(byCode(cycleResult, CODES.HIERARCHY_CYCLE).map((item) => [item.category, item.kind, item.id, item.field]),
    [['conflicts', 'node', 'module.a', 'parentId']]);

  const duplicated = baseModel({ nodes: [node('module.dup'), node('module.dup')] });
  const duplicateResult = healthCheck(duplicated);
  assertStableShape(duplicateResult);
  assert.deepEqual(byCode(duplicateResult, CODES.DUPLICATE_ID).map((item) => [item.category, item.kind, item.id, item.field]),
    [['conflicts', 'node', 'module.dup', 'id']]);
});

test('coverage completeness is reported only when the model declares it false', () => {
  const complete = healthCheck(baseModel({ coverage: { filesScanned: 1, complete: true } }));
  assertStableShape(complete);
  assert.equal(byCode(complete, CODES.COVERAGE_INCOMPLETE).length, 0);
  assert.deepEqual(complete.model.coverage, { filesScanned: 1, complete: true });

  const incomplete = healthCheck(baseModel({ coverage: { filesScanned: 1, complete: false } }));
  assertStableShape(incomplete);
  assert.deepEqual(byCode(incomplete, CODES.COVERAGE_INCOMPLETE).map((item) => [item.kind, item.id, item.field]),
    [['model', null, 'coverage.complete']]);

  const withoutCoverage = baseModel();
  delete withoutCoverage.coverage;
  const missing = healthCheck(withoutCoverage);
  assertStableShape(missing);
  assert.equal(byCode(missing, CODES.COVERAGE_INCOMPLETE).length, 0);
  assert.deepEqual(codesOf(missing), ['missing_required_field @ model:-.coverage']);
  assert.deepEqual(missing.model.coverage, { filesScanned: null, complete: null });

  const wrongType = healthCheck(baseModel({ coverage: { filesScanned: 1, complete: 'yes' } }));
  assertStableShape(wrongType);
  assert.equal(byCode(wrongType, CODES.COVERAGE_INCOMPLETE).length, 0);
  assert.deepEqual(codesOf(wrongType), ['invalid_type @ model:-.coverage.complete']);
});

test('declared unknowns are reported as unresolved gaps, malformed ones only as contract findings', () => {
  const empty = healthCheck(baseModel({ unknowns: [] }));
  assertStableShape(empty);
  assert.equal(byCode(empty, CODES.DECLARED_UNKNOWN).length, 0);

  const long = 'q'.repeat(200);
  const model = baseModel({
    unknowns: [
      { id: 'u.1', question: 'Which team owns the schema?' },
      { id: 'u.2' },
      { id: 'u.3', question: long },
      { id: '   ' },
    ],
  });
  const result = healthCheck(model);

  assertStableShape(result);
  const declared = byCode(result, CODES.DECLARED_UNKNOWN);
  assert.deepEqual(declared.map((item) => item.id), ['u.1', 'u.2', 'u.3']);
  assert.deepEqual(declared.map((item) => item.category), ['unknowns', 'unknowns', 'unknowns']);
  assert.deepEqual(declared.map((item) => item.field), ['question', 'question', 'question']);
  assert.match(declared[0].message, /Which team owns the schema\?$/);
  assert.equal(declared[1].message, 'Unknown "u.2" is declared and still unresolved.');
  assert.ok(declared[2].message.endsWith('...'));
  assert.equal(declared[2].message.includes('q'.repeat(121)), false);
  assert.deepEqual(byCode(result, CODES.EMPTY_STRING).map((item) => [item.kind, item.field]),
    [['model', 'unknowns[3].id']]);
});

test('empty evidenceIds on a node or an edge is reported as missing evidence', () => {
  const model = baseModel({
    nodes: [node('module.a', { evidenceIds: ['ev.a'] }), node('module.b', { evidenceIds: [] })],
    edges: [edge('edge.a.b', 'module.a', 'module.b', { evidenceIds: [] })],
    evidence: [evidenceEntry('ev.a', 'src/a.js')],
  });
  const result = healthCheck(model);

  assertStableShape(result);
  assert.deepEqual(byCode(result, CODES.MISSING_EVIDENCE).map((item) => `${item.kind}:${item.id}`),
    ['edge:edge.a.b', 'node:module.b']);

  const absent = baseModel({ nodes: [{ id: 'module.a', name: 'a', type: 'module', state: 'current', status: 'inferred', confidence: 'medium' }] });
  const absentResult = healthCheck(absent);
  assertStableShape(absentResult);
  assert.deepEqual(codesOf(absentResult), ['missing_required_field @ node:module.a.evidenceIds']);
});

test('low and unknown confidence are reported per fact, other values are not', () => {
  const model = baseModel({
    nodes: [
      node('module.high', { confidence: 'high' }),
      node('module.medium', { confidence: 'medium' }),
      node('module.low', { confidence: 'low' }),
      node('module.unknown', { confidence: 'unknown' }),
      node('module.bogus', { confidence: 'constructor' }),
    ],
  });
  const result = healthCheck(model);

  assertStableShape(result);
  assert.deepEqual(byCode(result, CODES.LOW_CONFIDENCE_FACT).map((item) => item.id), ['module.low']);
  assert.deepEqual(byCode(result, CODES.UNKNOWN_CONFIDENCE_FACT).map((item) => item.id), ['module.unknown']);
  assert.deepEqual(byCode(result, CODES.INVALID_ENUM_VALUE).map((item) => item.id), ['module.bogus']);
  assert.equal(byCode(result, CODES.LOW_CONFIDENCE_FACT)[0].category, 'confidence');
  assert.equal(byCode(result, CODES.LOW_CONFIDENCE_FACT)[0].field, 'confidence');
});

test('source verification and freshness stay unverified even when the model declares fingerprints', () => {
  const model = baseModel({
    nodes: [node('module.a', { status: 'confirmed', confidence: 'high', evidenceIds: ['ev.a'] })],
    evidence: [
      evidenceEntry('ev.a', 'src/a.js', { fingerprint: 'sha256:abc', contentHash: 'abc', revision: 'r1', stale: true }),
    ],
    sourceRevision: 'r1',
  });
  const result = healthCheck(model);

  assertStableShape(result);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.unverified, {
    sourceContentVerified: false,
    evidenceFreshness: 'unknown',
    artifactFreshness: 'unknown',
    reasons: [
      'sourceContentVerified=false: health reads the model document only and never compares it with the working tree.',
      'evidenceFreshness=unknown: judging freshness needs a source read or a comparable revision, and health performs neither.',
      'artifactFreshness=unknown: no diagram, report or export artifact was read or checked.',
    ],
  });
  assert.deepEqual(result.limitations, [
    'Computed from the model document alone; no source file, repository revision or artifact was read.',
    'Structural findings are limited to references and claims the model makes about itself; differences against source code are not inferred.',
    'Declared unknowns are reported as recorded gaps; this check does not resolve them.',
    'No clock is consulted, so nothing here states whether the model or its evidence is stale.',
  ]);
});

test('new health codes are registered as stable protocol values', () => {
  assert.equal(CODES.COVERAGE_INCOMPLETE, 'coverage_incomplete');
  assert.equal(CODES.DECLARED_UNKNOWN, 'declared_unknown');
  assert.equal(CODES.MISSING_EVIDENCE, 'missing_evidence');
  assert.equal(CODES.LOW_CONFIDENCE_FACT, 'low_confidence_fact');
  assert.equal(CODES.UNKNOWN_CONFIDENCE_FACT, 'unknown_confidence_fact');

  for (const code of [CODES.COVERAGE_INCOMPLETE, CODES.DECLARED_UNKNOWN, CODES.MISSING_EVIDENCE,
    CODES.LOW_CONFIDENCE_FACT, CODES.UNKNOWN_CONFIDENCE_FACT]) {
    assert.equal(isKnownCode(code), true, `code ${code} must be documented`);
    assert.equal(typeof CODE_MESSAGES[code], 'string');
  }
});

test('every code emitted for the fixtures is a registered, documented code', () => {
  const models = [
    readFixture('valid-minimal-model.json'),
    readFixture('invalid-dangling-edge.json'),
    readFixture('invalid-unproven-fact.json'),
    cleanModel(),
    { schemaVersion: 1 },
  ];

  for (const model of models) {
    const result = healthCheck(model);
    assertStableShape(result);
    for (const item of result.findings) {
      assert.equal(isKnownCode(item.code), true);
      assert.equal(typeof CODE_MESSAGES[item.code], 'string');
    }
  }
});
