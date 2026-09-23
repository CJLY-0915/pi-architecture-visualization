'use strict';

const { CODES } = require('../core/error-codes');
const { validateModel } = require('../core/validation');
const { normalizeCollectOptions } = require('./options');
const { collect } = require('./inventory');
const { evidenceId } = require('./ids');
const jsTs = require('./js-ts');
const manifests = require('./manifests');
const infra = require('./infra');

// Deterministic read-only model assembly.
//
// The collector is a pure function of the injected `source`: it never touches the
// filesystem, the network or the clock (the only wall-clock use is the timeout
// comparison inside the inventory). Adapters run in a fixed order over files
// sorted by ascending path, and every output array is sorted before it is
// returned, so neither the order of source.listFiles() nor object key order can
// change a single byte of the result.
//
// Epistemic split: adapters may only emit `confirmed` when the same evidence
// entry that proves the claim is declared. A construct the adapter cannot
// resolve becomes an `unresolved` entry instead of a guess, and a construct it
// cannot model at all becomes `unsupported_input`. Coverage gaps are reported
// through `coverage.complete` rather than silently presenting a partial scan as
// a complete one. `unknowns` stays empty in v1: it holds open architectural
// questions, not scan gaps, and the collector has no source for those yet.

const ADAPTER_IDS = Object.freeze(['js-ts', 'manifests', 'infra']);
const ADAPTER_FACTORIES = Object.freeze({
  'js-ts': jsTs.create,
  manifests: manifests.create,
  infra: infra.create,
});

// Codes that mean "the model cannot be trusted", as opposed to a limit that was
// reached or a single construct that could not be resolved.
const FATAL_CODES = Object.freeze([CODES.INVALID_OPTION, CODES.SOURCE_LIST_FAILED, CODES.INTERNAL_ERROR]);

const STATUS_RANK = Object.freeze({ confirmed: 3, inferred: 2, assumed: 1, unknown: 0 });
const CONFIDENCE_RANK = Object.freeze({ high: 3, medium: 2, low: 1, unknown: 0 });

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const { compareStrings } = require('../core/compare-strings');

// Diagnostics and unresolved entries share one shape, so they share one order.
function compareEntries(left, right) {
  return compareStrings(left.path, right.path)
    || compareStrings(left.code, right.code)
    || compareStrings(left.message, right.message);
}

function uniqueSorted(values) {
  return Array.from(new Set(values)).sort(compareStrings);
}

function sortById(items) {
  return items.slice().sort((left, right) => compareStrings(left.id, right.id));
}

function strongest(current, candidate, ranks) {
  return ranks[candidate] > ranks[current] ? candidate : current;
}

/**
 * Collects adapter output, merging repeated ids.
 *
 * A node id claimed by several adapters (a declared dependency that is also
 * imported, a package.json seen twice) becomes one node: evidence is unioned and
 * the strongest status/confidence wins, so a declaration can raise an import
 * from `inferred` to `confirmed` but nothing can ever be downgraded to hide
 * evidence. Adapters never set `state`; every collected node is a current-state
 * observation.
 */
function createContext(filesByPath) {
  const nodes = new Map();
  const edges = new Map();
  const evidence = new Map();
  const unresolved = [];

  function addEvidence(reference) {
    const id = evidenceId(reference.path, reference.line, reference.type);
    if (!evidence.has(id)) {
      const entry = { id, path: reference.path, type: reference.type };
      if (reference.line !== undefined) entry.line = reference.line;
      evidence.set(id, entry);
    }
    return id;
  }

  function addNode(node) {
    const existing = nodes.get(node.id);
    if (existing === undefined) {
      nodes.set(node.id, Object.assign({}, node, { state: 'current', evidenceIds: uniqueSorted(node.evidenceIds) }));
      return;
    }
    existing.evidenceIds = uniqueSorted(existing.evidenceIds.concat(node.evidenceIds));
    existing.status = strongest(existing.status, node.status, STATUS_RANK);
    existing.confidence = strongest(existing.confidence, node.confidence, CONFIDENCE_RANK);
    for (const [key, value] of Object.entries(node)) {
      if (key === 'id' || key === 'status' || key === 'confidence' || key === 'evidenceIds' || key === 'state') continue;
      if (existing[key] === undefined) existing[key] = value;
    }
  }

  function addEdge(edge) {
    const existing = edges.get(edge.id);
    if (existing === undefined) {
      edges.set(edge.id, Object.assign({}, edge, { state: 'current', evidenceIds: uniqueSorted(edge.evidenceIds) }));
      return;
    }
    existing.evidenceIds = uniqueSorted(existing.evidenceIds.concat(edge.evidenceIds));
    existing.status = strongest(existing.status, edge.status, STATUS_RANK);
    existing.confidence = strongest(existing.confidence, edge.confidence, CONFIDENCE_RANK);
  }

  return {
    filesByPath,
    addEvidence,
    addNode,
    addEdge,
    unresolved(code, path, message) {
      unresolved.push({ code, path, message });
    },
    snapshot() {
      return {
        nodes: Array.from(nodes.values()),
        edges: Array.from(edges.values()),
        evidence: Array.from(evidence.values()),
        unresolved: unresolved.slice(),
      };
    },
  };
}

// The model carries the whole coverage ledger, not just the scanned count. A
// saved model must be able to show that files were listed and withheld, or a
// consumer reading only the file cannot tell a full scan from a partial one.
function emptyModel(options, coverage) {
  return {
    schemaVersion: 1,
    project: { id: options.projectId },
    scope: { roots: options.scopeRoots },
    sourceRevision: options.sourceRevision,
    generatedAt: options.generatedAt,
    coverage: {
      filesListed: coverage.filesListed,
      filesScanned: coverage.filesScanned,
      filesSkipped: coverage.filesSkipped,
      complete: coverage.complete,
    },
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

// Used only when the options are unusable: no scan happened, so coverage must
// never claim completeness.
function emptyInventory() {
  return {
    filesListed: 0,
    filesScanned: 0,
    filesSkipped: 0,
    complete: false,
    files: [],
    unanalyzed: [],
    unresolved: [],
    diagnostics: [],
  };
}

function assemble(options, inventory, optionDiagnostics, sourceDiagnostics) {
  const filesByPath = new Map();
  for (const file of inventory.files) filesByPath.set(file.path, file.text);

  const context = createContext(filesByPath);
  // Source diagnostics come from the host traversal and describe limits the
  // inventory cannot see from inside (host caps, unlistable directories), so they
  // count towards completeness exactly like the inventory's own limits.
  const diagnostics = optionDiagnostics.concat(inventory.diagnostics, sourceDiagnostics);
  const adapters = [];
  const complete = inventory.complete && !hasCompletenessGap(sourceDiagnostics);

  for (const id of ADAPTER_IDS) {
    const adapter = ADAPTER_FACTORIES[id]();
    let matched = 0;
    for (const file of inventory.files) {
      if (!adapter.match(file.path)) continue;
      matched += 1;
      try {
        adapter.analyze(file, context);
      } catch {
        // One unparsable file must not abort the scan; the file is reported as
        // an internal failure and everything already derived from it is kept.
        diagnostics.push({
          code: CODES.INTERNAL_ERROR,
          path: file.path,
          message: `The ${id} adapter failed on this file; only the output derived before the failure was kept.`,
        });
      }
    }
    adapters.push({
      id,
      matched,
      limited: inventory.unanalyzed.some((path) => adapter.match(path)),
    });
  }

  const model = emptyModel(options, {
    filesListed: inventory.filesListed,
    filesScanned: inventory.filesScanned,
    filesSkipped: inventory.filesSkipped,
    complete,
  });
  const collected = context.snapshot();
  model.nodes = sortById(collected.nodes);
  model.edges = sortById(collected.edges);
  model.evidence = sortById(collected.evidence);

  const sortedDiagnostics = diagnostics.sort(compareEntries);
  const unresolved = inventory.unresolved.concat(collected.unresolved).sort(compareEntries);
  const validation = validateModel(model);

  return {
    ok: validation.valid && !sortedDiagnostics.some((entry) => FATAL_CODES.includes(entry.code)),
    model,
    validation,
    coverage: {
      filesListed: inventory.filesListed,
      filesScanned: inventory.filesScanned,
      filesSkipped: inventory.filesSkipped,
      complete,
      adapters: adapters.sort((left, right) => compareStrings(left.id, right.id)),
    },
    unresolved,
    diagnostics: sortedDiagnostics,
  };
}

/**
 * Builds a v1 architecture model from an injected read-only file source.
 *
 * Never throws and never writes: an unusable source, unusable options or a file
 * that cannot be read all produce diagnostics plus a structurally valid model
 * instead of an exception. `ok` is false when the model is invalid or a fatal
 * diagnostic was reported; reaching a file-count, size or timeout limit instead
 * sets `coverage.complete` to false while `ok` stays true, so a truncated scan
 * is visible as incomplete rather than as a failure.
 *
 * @param {{source?: {listFiles: () => Promise<string[]>, readText: (path: string) => Promise<string>}, options?: object, sourceDiagnostics?: Array<object>}} input
 *   `sourceDiagnostics` carries limits detected by the injected source itself
 *   (host caps, unlistable directories); any entry forces `coverage.complete`
 *   to false.
 * @returns {Promise<{ok: boolean, model: object, validation: object, coverage: object, unresolved: Array<object>, diagnostics: Array<object>}>}
 */
// A limit or an unlistable directory means the file set is known to be partial;
// an unusable scope root or a protected path has the same effect. An
// unrecognised code is treated as a gap too, so a future source cannot silently
// claim completeness through a code this list has not learned yet.
function hasCompletenessGap(entries) {
  return entries.length > 0;
}

async function collectModel(input) {
  const request = isPlainObject(input) ? input : {};
  const options = normalizeCollectOptions(request.options);

  // Invalid options abort before the source is touched: guessing a project id or
  // a timestamp would produce a model that looks authoritative but is not.
  const sourceDiagnostics = Array.isArray(request.sourceDiagnostics) ? request.sourceDiagnostics : [];
  if (options.diagnostics.length > 0) return assemble(options, emptyInventory(), options.diagnostics, sourceDiagnostics);

  return assemble(options, await collect({ source: request.source, options }), options.diagnostics, sourceDiagnostics);
}

module.exports = { collectModel, ADAPTER_IDS };
