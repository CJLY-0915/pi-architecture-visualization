'use strict';

// The collect tool's response is bounded by main.js before it reaches the
// agent. These tests exercise that budgeting directly: the per-list caps, the
// byte budget, and the guarantee that the shrink loop always terminates.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  summarize,
  MAX_SUMMARY_BYTES,
  MAX_SUMMARY_NODES,
  MAX_SUMMARY_EDGES,
  MAX_SUMMARY_ENTRIES,
} = require('../main');

function node(id, nameLength = 0) {
  return {
    id: `file:${id}.js`,
    name: nameLength > 0 ? 'n'.repeat(nameLength) : id,
    type: 'module',
    status: 'confirmed',
    confidence: 'high',
    evidenceIds: [`evidence:${id}`],
  };
}

function edge(id, nameLength = 0) {
  const padding = nameLength > 0 ? 'e'.repeat(nameLength) : '';
  return {
    id: `edge:${id}`,
    source: `file:${id}-a.js${padding}`,
    target: `file:${id}-b.js${padding}`,
    type: 'depends_on',
    status: 'confirmed',
    evidenceIds: [`evidence:${id}`],
  };
}

function evidence(id) {
  return { id: `evidence:${id}`, path: `src/${id}.js`, line: 1, excerpt: `const ${id} = 1;` };
}

// Shape of the object `collectModel` returns, reduced to what `summarize` reads.
function collected(overrides = {}) {
  const {
    nodes = [], edges = [], evidenceEntries = [], unresolved = [], diagnostics = [],
    validationDiagnostics = [], valid = true, ok = true,
  } = overrides;
  return {
    ok,
    coverage: { filesListed: nodes.length, filesScanned: nodes.length, filesSkipped: 0, complete: true, adapters: [] },
    model: { nodes, edges, evidence: evidenceEntries },
    unresolved,
    diagnostics,
    validation: { valid, diagnostics: validationDiagnostics },
  };
}

function sizeOf(summary) {
  return Buffer.byteLength(JSON.stringify(summary), 'utf8');
}

test('a result that fits is summarised without omissions', () => {
  const summary = summarize(collected({
    nodes: [node('a')],
    edges: [edge('e1')],
    evidenceEntries: [evidence('a')],
  }));

  assert.equal(summary.counts.nodes, 1);
  assert.equal(summary.counts.edges, 1);
  assert.equal(summary.counts.evidence, 1);
  assert.equal(summary.nodes.length, 1);
  assert.equal(summary.edges.length, 1);
  assert.equal(summary.evidence.length, 1);
  // Nothing was withheld, so no omission report may appear.
  assert.equal('truncated' in summary, false);
  assert.equal('truncatedNote' in summary, false);
});

test('each list is capped and the omitted count is reported', () => {
  const summary = summarize(collected({
    nodes: Array.from({ length: MAX_SUMMARY_NODES + 40 }, (_, index) => node(`n${index}`)),
    edges: Array.from({ length: MAX_SUMMARY_EDGES + 40 }, (_, index) => edge(`e${index}`)),
    evidenceEntries: Array.from({ length: MAX_SUMMARY_ENTRIES + 40 }, (_, index) => evidence(`v${index}`)),
  }));

  assert.equal(summary.counts.nodes, MAX_SUMMARY_NODES + 40);
  assert.equal(summary.nodes.length, MAX_SUMMARY_NODES);
  assert.equal(summary.edges.length, MAX_SUMMARY_EDGES);
  assert.equal(summary.evidence.length, MAX_SUMMARY_ENTRIES);
  assert.deepEqual(summary.truncated, {
    nodes: 40,
    edges: 40,
    evidence: 40,
  });
  // The note must say that nothing was written and that omitted evidence may
  // still be referenced, otherwise a reader would treat the tail as absent.
  assert.match(summary.truncatedNote, /nothing was written/);
  assert.match(summary.truncatedNote, /Omitted evidence/);
});

test('the byte budget bounds the response and keeps the true counts', () => {
  // 150 nodes of 4 KiB each is far past the budget, so the loop has to drop
  // entries rather than trust the per-list cap.
  const summary = summarize(collected({
    nodes: Array.from({ length: MAX_SUMMARY_NODES }, (_, index) => node(`n${index}`, 4096)),
  }));

  assert.ok(sizeOf(summary) <= MAX_SUMMARY_BYTES, `summary is ${sizeOf(summary)} bytes`);
  assert.equal(summary.counts.nodes, MAX_SUMMARY_NODES);
  assert.equal(summary.truncated.nodes, MAX_SUMMARY_NODES - summary.nodes.length);
  assert.ok(summary.nodes.length < MAX_SUMMARY_NODES);
});

test('a single entry larger than the whole budget still terminates', () => {
  // The shrink loop pops from the largest non-empty list, so one oversized
  // entry has to leave a bounded, still well-formed summary behind.
  const summary = summarize(collected({ nodes: [node('huge', MAX_SUMMARY_BYTES)] }));

  assert.ok(sizeOf(summary) <= MAX_SUMMARY_BYTES, `summary is ${sizeOf(summary)} bytes`);
  assert.equal(summary.nodes.length, 0);
  assert.equal(summary.counts.nodes, 1);
  assert.deepEqual(summary.truncated, { nodes: 1 });
});

test('coverage and validation survive even when every list is dropped', () => {
  const summary = summarize(collected({
    nodes: [node('a', MAX_SUMMARY_BYTES)],
    edges: [edge('e', MAX_SUMMARY_BYTES)],
    evidenceEntries: [evidence('v', MAX_SUMMARY_BYTES)],
    unresolved: [{ code: 'unsupported_input', path: 'src/x.go', message: 'm'.repeat(MAX_SUMMARY_BYTES) }],
    diagnostics: [{ code: 'file_too_large', path: 'big.dat', message: 'm'.repeat(MAX_SUMMARY_BYTES) }],
    valid: false,
    ok: false,
  }));

  assert.ok(sizeOf(summary) <= MAX_SUMMARY_BYTES, `summary is ${sizeOf(summary)} bytes`);
  // The caller must still be able to tell that the run was not usable.
  assert.equal(summary.ok, false);
  assert.equal(summary.validation.valid, false);
  assert.deepEqual(summary.coverage, {
    filesListed: 1, filesScanned: 1, filesSkipped: 0, complete: true, adapters: [],
  });
  assert.equal(summary.counts.nodes, 1);
});

test('the budget constants match the documented host limits', () => {
  assert.equal(MAX_SUMMARY_BYTES, 240 * 1024);
  assert.equal(MAX_SUMMARY_NODES, 150);
  assert.equal(MAX_SUMMARY_EDGES, 300);
  assert.equal(MAX_SUMMARY_ENTRIES, 100);
});
