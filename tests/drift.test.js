'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeDrift } = require('../src/core/drift');
const { CODES } = require('../src/core/error-codes');
const fixture = require('../fixtures/valid-minimal-model.json');

const clone = (value) => JSON.parse(JSON.stringify(value));

// scope root "." accepts any relative path, so a factory model stays valid for
// arbitrary evidence paths without touching the filesystem.
function makeModel(overrides = {}) {
  return {
    schemaVersion: 1,
    project: { id: 'p', name: 'P' },
    scope: { roots: ['.'] },
    sourceRevision: null,
    generatedAt: '2024-01-01T00:00:00Z',
    coverage: { filesScanned: 1, complete: true },
    nodes: [], edges: [], evidence: [],
    views: [], findings: [], decisions: [], migrationSlices: [], unknowns: [],
    ...overrides,
  };
}

function observed({ enumerated = [], modelled = [], complete = true, limits } = {}) {
  const value = { enumerated, modelled, complete };
  if (limits !== undefined) value.limits = limits;
  return value;
}

const FIXTURE_PATHS = ['README.md', 'src/main.js', 'src/invoice/store.js'];
const NO_GIT = /no git state was read/;
const NO_CONTENT = /no source file content was read/;
const EXISTENCE_UNKNOWN_REASON = 'the workspace enumeration was incomplete, so a missing path is not evidence that the file is gone';

test('every cited path enumerated and modelled is aligned with no findings', () => {
  const result = computeDrift({ model: clone(fixture), observed: observed({ enumerated: FIXTURE_PATHS, modelled: FIXTURE_PATHS }) });
  assert.equal(result.ok, true);
  assert.equal(result.verdict, 'aligned');
  assert.deepEqual(result.findings.missingEvidence, []);
  assert.deepEqual(result.findings.noLongerModelled, []);
  assert.deepEqual(result.findings.existenceUnknown, []);
  assert.deepEqual(result.findings.unmodelledPaths, []);
  assert.equal(result.truncated, false);
});

test('a complete scan missing a cited path reports missing evidence with citing ids and drifts', () => {
  const result = computeDrift({ model: clone(fixture), observed: observed({ enumerated: ['README.md', 'src/main.js'], modelled: ['README.md', 'src/main.js'] }) });
  assert.equal(result.verdict, 'drifted');
  assert.equal(result.findings.missingEvidence.length, 1);
  const finding = result.findings.missingEvidence[0];
  assert.equal(finding.evidenceId, 'ev.invoice');
  assert.equal(finding.path, 'src/invoice/store.js');
  assert.deepEqual(finding.nodeIds, ['module.invoice']);
  assert.deepEqual(finding.edgeIds, ['edge.api.invoice', 'edge.invoice.db']);
  assert.deepEqual(result.findings.existenceUnknown, []);
  assert.deepEqual(result.findings.noLongerModelled, []);
});

test('an incomplete scan missing the same path reports existence unknown, never aligned or drifted', () => {
  const result = computeDrift({ model: clone(fixture), observed: observed({ enumerated: ['README.md', 'src/main.js'], modelled: ['README.md', 'src/main.js'], complete: false }) });
  assert.equal(result.verdict, 'incomplete');
  assert.notEqual(result.verdict, 'aligned');
  assert.notEqual(result.verdict, 'drifted');
  assert.deepEqual(result.findings.missingEvidence, []);
  assert.equal(result.findings.existenceUnknown.length, 1);
  const finding = result.findings.existenceUnknown[0];
  assert.equal(finding.evidenceId, 'ev.invoice');
  assert.equal(finding.reason, EXISTENCE_UNKNOWN_REASON);
  assert.deepEqual(finding.nodeIds, ['module.invoice']);
  assert.deepEqual(finding.edgeIds, ['edge.api.invoice', 'edge.invoice.db']);
});

test('a path enumerated but not modelled is no longer modelled, not missing evidence', () => {
  const result = computeDrift({ model: clone(fixture), observed: observed({ enumerated: FIXTURE_PATHS, modelled: ['README.md', 'src/main.js'] }) });
  assert.equal(result.verdict, 'drifted');
  assert.deepEqual(result.findings.missingEvidence, []);
  assert.equal(result.findings.noLongerModelled.length, 1);
  assert.equal(result.findings.noLongerModelled[0].evidenceId, 'ev.invoice');
  assert.equal(result.findings.noLongerModelled[0].path, 'src/invoice/store.js');
});

test('a modelled path the model never cites lands in unmodelled paths sorted, and stays aligned', () => {
  const enumerated = [...FIXTURE_PATHS, 'src/orphan.js', 'src/apple.js'];
  const result = computeDrift({ model: clone(fixture), observed: observed({ enumerated, modelled: enumerated }) });
  assert.deepEqual(result.findings.unmodelledPaths, [{ path: 'src/apple.js' }, { path: 'src/orphan.js' }]);
  assert.equal(result.verdict, 'aligned');
});

test('an empty enumerated list is incomplete, not aligned, and says so in the limits', () => {
  const result = computeDrift({ model: clone(fixture), observed: observed({ enumerated: [], modelled: [] }) });
  assert.equal(result.verdict, 'incomplete');
  assert.notEqual(result.verdict, 'aligned');
  assert.ok(result.limits.some((line) => /enumerated no paths/.test(line)));
});

test('max findings truncates each list, counts the omissions, and records a limit line', () => {
  const evidence = [0, 1, 2, 3, 4].map((n) => ({ id: `ev.${n}`, path: `src/f${n}.js`, type: 'code' }));
  const result = computeDrift({ model: makeModel({ evidence }), observed: observed({ enumerated: [], modelled: [] }), maxFindings: 2 });
  assert.equal(result.truncated, true);
  assert.deepEqual(result.findings.missingEvidence.map((entry) => entry.evidenceId), ['ev.0', 'ev.1']);
  assert.equal(result.omitted.missingEvidence, 3);
  assert.equal(result.counts.missingEvidence, 5);
  assert.ok(result.limits.some((line) => /maxFindings=2/.test(line) && /omitted:/.test(line)));
});

test('an invalid model fails without throwing and carries the validation result', () => {
  const result = computeDrift({ model: {}, observed: observed({}) });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'invalid_model');
  assert.equal(result.validation.valid, false);
  assert.ok(Array.isArray(result.limits) && result.limits.length > 0);
  assert.equal(computeDrift({ model: null, observed: observed({}) }).ok, false);
});

test('malformed observed shapes and out-of-range max findings are rejected with invalid_option', () => {
  const model = clone(fixture);
  const badObserved = [
    undefined, null, 'x', [],
    { enumerated: 'x', modelled: [], complete: true },
    { enumerated: [], modelled: 'x', complete: true },
    { enumerated: [1], modelled: [], complete: true },
    { enumerated: [], modelled: [], complete: 'yes' },
    { enumerated: [], modelled: [], complete: true, limits: 'x' },
  ];
  for (const value of badObserved) {
    const result = computeDrift({ model, observed: value });
    assert.equal(result.ok, false, JSON.stringify(value));
    assert.equal(result.error.code, CODES.INVALID_OPTION);
  }
  for (const value of [0, -1, 1.5, 1001, '5', null]) {
    const result = computeDrift({ model, observed: observed({}), maxFindings: value });
    assert.equal(result.ok, false, String(value));
    assert.equal(result.error.code, CODES.INVALID_OPTION);
  }
});

test('max findings accepts the documented 1 to 1000 range', () => {
  const model = clone(fixture);
  for (const value of [1, 100, 1000]) {
    const result = computeDrift({ model, observed: observed({ enumerated: FIXTURE_PATHS, modelled: FIXTURE_PATHS }), maxFindings: value });
    assert.equal(result.ok, true, String(value));
  }
});

test('limits always state that no git state and no source content were read', () => {
  const aligned = computeDrift({ model: clone(fixture), observed: observed({ enumerated: FIXTURE_PATHS, modelled: FIXTURE_PATHS }) });
  assert.ok(aligned.limits.some((line) => NO_GIT.test(line)));
  assert.ok(aligned.limits.some((line) => NO_CONTENT.test(line)));
  const failed = computeDrift(null);
  assert.ok(failed.limits.some((line) => NO_GIT.test(line)));
  assert.ok(failed.limits.some((line) => NO_CONTENT.test(line)));
});

test('garbage input never throws and always yields a structured failure with limits', () => {
  for (const garbage of [null, 'string', 42, true, [], undefined]) {
    const result = computeDrift(garbage);
    assert.equal(result.ok, false, String(garbage));
    assert.ok(result.error && typeof result.error.code === 'string');
    assert.ok(Array.isArray(result.limits) && result.limits.length > 0);
  }
});

test('drift wins over existence unknown when both a no-longer-modelled and an unknown path appear', () => {
  const model = makeModel({ evidence: [{ id: 'ev.a', path: 'src/a.js', type: 'code' }, { id: 'ev.b', path: 'src/b.js', type: 'code' }] });
  const result = computeDrift({ model, observed: observed({ enumerated: ['src/a.js'], modelled: [], complete: false }) });
  assert.equal(result.findings.noLongerModelled.length, 1);
  assert.equal(result.findings.existenceUnknown.length, 1);
  assert.equal(result.verdict, 'drifted');
});

test('counts report full totals independent of truncation', () => {
  const model = makeModel({ evidence: [
    { id: 'ev.a', path: 'src/a.js', type: 'code' },
    { id: 'ev.b', path: 'src/b.js', type: 'code' },
    { id: 'ev.c', path: 'src/c.js', type: 'code' },
  ] });
  const result = computeDrift({ model, observed: observed({ enumerated: ['src/a.js', 'src/orphan.js'], modelled: ['src/a.js', 'src/orphan.js'] }) });
  assert.equal(result.counts.evidence, 3);
  assert.equal(result.counts.missingEvidence, 2);
  assert.equal(result.counts.unmodelledPaths, 1);
  assert.equal(result.counts.enumerated, 2);
  assert.equal(result.counts.modelled, 2);
  assert.equal(result.counts.pathlessEvidence, 0);
});

test('an incomplete scan that still saw every cited path is aligned but discloses the incompleteness', () => {
  const result = computeDrift({ model: clone(fixture), observed: observed({ enumerated: FIXTURE_PATHS, modelled: FIXTURE_PATHS, complete: false, limits: [{ code: 'file_limit_reached', path: 'src', message: 'stopped early' }] }) });
  assert.equal(result.verdict, 'aligned');
  assert.ok(result.limits.some((line) => /incomplete/.test(line) && /file_limit_reached/.test(line)));
});

test('unmodelled paths are deduplicated', () => {
  const result = computeDrift({ model: clone(fixture), observed: observed({ enumerated: ['src/x.js'], modelled: ['src/x.js', 'src/x.js', 'src/y.js'] }) });
  assert.deepEqual(result.findings.unmodelledPaths, [{ path: 'src/x.js' }, { path: 'src/y.js' }]);
});

test('a model that cites no file paths is incomplete, not aligned', () => {
  const result = computeDrift({ model: makeModel(), observed: observed({ enumerated: ['src/a.js'], modelled: ['src/a.js'] }) });
  assert.equal(result.verdict, 'incomplete');
  assert.notEqual(result.verdict, 'aligned');
  assert.ok(result.limits.some((line) => /cites no file paths/.test(line)));
});

test('evidence findings carry sorted, deduped citing node and edge ids, empty when uncited', () => {
  const cited = makeModel({
    evidence: [{ id: 'ev.multi', path: 'src/multi.js', type: 'code' }],
    nodes: [
      { id: 'n.z', name: 'Z', type: 'module', state: 'current', status: 'inferred', confidence: 'low', evidenceIds: ['ev.multi', 'ev.multi'] },
      { id: 'n.a', name: 'A', type: 'module', state: 'current', status: 'inferred', confidence: 'low', evidenceIds: ['ev.multi'] },
    ],
    edges: [
      { id: 'e.z', source: 'n.a', target: 'n.z', type: 'calls', state: 'current', status: 'inferred', confidence: 'low', evidenceIds: ['ev.multi'] },
    ],
  });
  const result = computeDrift({ model: cited, observed: observed({ enumerated: [], modelled: [] }) });
  assert.deepEqual(result.findings.missingEvidence[0].nodeIds, ['n.a', 'n.z']);
  assert.deepEqual(result.findings.missingEvidence[0].edgeIds, ['e.z']);

  const uncited = computeDrift({ model: makeModel({ evidence: [{ id: 'ev.solo', path: 'src/solo.js', type: 'code' }] }), observed: observed({ enumerated: [], modelled: [] }) });
  assert.deepEqual(uncited.findings.missingEvidence[0].nodeIds, []);
  assert.deepEqual(uncited.findings.missingEvidence[0].edgeIds, []);
});

test('the assessment never mutates the model or the observed input', () => {
  const model = clone(fixture);
  const scan = observed({ enumerated: ['README.md'], modelled: ['README.md'], complete: false, limits: [{ code: 'file_limit_reached', path: 'src', message: 'x' }] });
  const modelSnapshot = JSON.stringify(model);
  const scanSnapshot = JSON.stringify(scan);
  computeDrift({ model, observed: scan, maxFindings: 1 });
  assert.equal(JSON.stringify(model), modelSnapshot);
  assert.equal(JSON.stringify(scan), scanSnapshot);
});
