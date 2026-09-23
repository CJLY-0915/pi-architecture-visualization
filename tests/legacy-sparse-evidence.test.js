'use strict';

// Regression lock for skills/legacy-system-visualizer on a genuinely sparse
// legacy system. The earlier acceptance ran on this repository itself, which is
// densely documented and therefore a poor fit for the skill's target case. This
// suite pins the skill's defining behaviour on fixtures/legacy-sparse-project:
// unknowns outnumber confirmed facts, the collector surfaces its blind spots as
// diagnostics instead of emitting a quiet empty graph, and every surviving
// confirmed fact still carries evidence.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { collectModel } = require('../src/collectors');
const { validateModel } = require('../src/core/validation');
const { healthCheck } = require('../src/core/health');
const { CODES } = require('../src/core/error-codes');

const ROOT_DIR = path.join(__dirname, '..');
const MODEL_PATH = path.join(ROOT_DIR, 'fixtures', 'legacy-sparse-model.json');
const FIXTURE_DIR = path.join(ROOT_DIR, 'fixtures', 'legacy-sparse-project');
const BASE_OPTIONS = Object.freeze({ projectId: 'legacy-order-service', generatedAt: '2024-05-01T09:30:00Z' });

function readModel() {
  return JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));
}

function listFixturePaths(dir, prefix = '') {
  const paths = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : 1))) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) paths.push(...listFixturePaths(path.join(dir, entry.name), relative));
    else paths.push(relative);
  }
  return paths;
}

function fixtureEntries() {
  const entries = {};
  for (const relative of listFixturePaths(FIXTURE_DIR)) {
    entries[relative] = fs.readFileSync(path.join(FIXTURE_DIR, relative), 'utf8');
  }
  return entries;
}

// In-memory stand-in for the host file source, mirroring tests/collectors.test.js.
function memorySource(entries, options = {}) {
  const reads = [];
  return {
    reads,
    listFiles: async () => {
      if (options.listFails) throw new Error('listFiles failed');
      return Object.keys(entries);
    },
    readText: async (filePath) => {
      reads.push(filePath);
      if (!Object.prototype.hasOwnProperty.call(entries, filePath)) throw new Error(`not listed: ${filePath}`);
      return entries[filePath];
    },
  };
}

async function collect(entries, options = {}, sourceOptions = {}) {
  const source = memorySource(entries, sourceOptions);
  const result = await collectModel({ source, options: Object.assign({}, BASE_OPTIONS, options) });
  return { result, source };
}

function codesOf(entries, code) {
  return entries.filter((entry) => entry.code === code);
}

test('the sparse legacy model is contract-valid and carries at least four unknowns', () => {
  const model = readModel();
  const result = validateModel(model);

  assert.equal(result.valid, true);
  assert.deepEqual(result.diagnostics, []);
  // A legacy model that recorded fewer open questions than this would be
  // guessing, not inventorying.
  assert.ok(model.unknowns.length >= 4, `expected >= 4 unknowns, saw ${model.unknowns.length}`);
  for (const unknown of model.unknowns) {
    assert.equal(typeof unknown.id, 'string');
    assert.ok(unknown.id.length > 0);
    assert.equal(typeof unknown.question, 'string');
    assert.ok(unknown.question.length > 0);
  }
});

test('unknowns and assumptions outnumber confirmed facts, the defining legacy property', () => {
  const model = readModel();
  const unknownOrAssumed = model.nodes.filter((node) => node.status === 'unknown' || node.status === 'assumed');
  const confirmed = model.nodes.filter((node) => node.status === 'confirmed');

  assert.ok(
    unknownOrAssumed.length > confirmed.length,
    `expected unknown/assumed (${unknownOrAssumed.length}) to outnumber confirmed (${confirmed.length})`,
  );
});

test('healthCheck reports every declared unknown, stays ok, and never claims source verification', () => {
  const model = readModel();
  const result = healthCheck(model);

  assert.equal(result.ok, true);
  assert.equal(result.validation.valid, true);
  assert.equal(result.unverified.sourceContentVerified, false);

  const reportedUnknownIds = new Set(result.findings.filter((finding) => finding.kind === 'unknown').map((finding) => finding.id));
  for (const unknown of model.unknowns) {
    assert.ok(reportedUnknownIds.has(unknown.id), `healthCheck dropped declared unknown ${unknown.id}`);
  }
});

test('the collector reports the sparse fixture blind spots instead of a quiet empty graph', async () => {
  const { result } = await collect(fixtureEntries());

  // The run itself is sound: a valid, non-empty model.
  assert.equal(result.validation.valid, true);
  assert.ok(result.model.nodes.length > 0, 'the collector must still produce a graph');

  // The dynamic requires and the unmodelled schedule are surfaced, not swallowed.
  assert.ok(result.unresolved.length > 0 || result.diagnostics.length > 0, 'blind spots must be reported');
  const unsupported = codesOf(result.unresolved, CODES.UNSUPPORTED_INPUT);
  assert.ok(
    unsupported.some((entry) => entry.path === 'src/index.js' && /non-literal/.test(entry.message)),
    'the require(routeVar) in src/index.js must be reported as unsupported_input',
  );
  assert.ok(
    unsupported.some((entry) => entry.path === 'src/legacy/orders.cjs' && /non-literal/.test(entry.message)),
    'the require(expr) in src/legacy/orders.cjs must be reported as unsupported_input',
  );
});

test('sparse does not mean unproven: every confirmed node still references evidence', () => {
  const model = readModel();
  const evidenceIds = new Set(model.evidence.map((entry) => entry.id));

  for (const node of model.nodes) {
    if (node.status !== 'confirmed') continue;
    assert.ok(Array.isArray(node.evidenceIds) && node.evidenceIds.length > 0, `${node.id} is confirmed without evidence`);
    for (const id of node.evidenceIds) {
      assert.ok(evidenceIds.has(id), `${node.id} references undeclared evidence ${id}`);
    }
  }
});
