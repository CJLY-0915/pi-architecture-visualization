'use strict';

// P7 architecture health check over one v1 model document.
//
// The check is a pure, deterministic read of the document: it never reads
// source files, artifacts or the clock, never writes anything and never throws.
// Every finding is either a diagnostic produced by validateModel() (reused
// verbatim, so structural rules keep exactly one source of truth in
// validation.js) or a fact the model itself declares.
//
// What the model cannot prove stays unknown: source content verification and
// evidence/artifact freshness are reported as unverified instead of guessed.
//
// Findings name the stable id of the fact they are about and are sorted, so two
// models that differ only in collection order produce identical findings.

const { validateModel } = require('./validation');
const { CODES } = require('./error-codes');
const { compareStrings } = require('./graph');

const SEVERITY_ERROR = 'error';
const SEVERITY_WARNING = 'warning';
const SEVERITY_INFO = 'info';

const CATEGORY_CONTRACT = 'contract';
const CATEGORY_CONFLICTS = 'conflicts';
const CATEGORY_COVERAGE = 'coverage';
const CATEGORY_UNKNOWNS = 'unknowns';
const CATEGORY_EVIDENCE = 'evidence';
const CATEGORY_CONFIDENCE = 'confidence';
const CATEGORIES = Object.freeze([
  CATEGORY_CONTRACT,
  CATEGORY_CONFLICTS,
  CATEGORY_COVERAGE,
  CATEGORY_UNKNOWNS,
  CATEGORY_EVIDENCE,
  CATEGORY_CONFIDENCE,
]);

// Validator codes that state an explicit conflict inside the document itself:
// references that do not resolve, facts claimed as confirmed without evidence,
// an edge state that contradicts its endpoints, duplicate ids. Every other
// validator code is a contract violation.
const CONFLICT_CODES = Object.freeze([
  CODES.DANGLING_EDGE_ENDPOINT,
  CODES.UNKNOWN_EVIDENCE_REFERENCE,
  CODES.UNPROVEN_CONFIRMED_FACT,
  CODES.EDGE_STATE_MISMATCH,
  CODES.UNKNOWN_PARENT_NODE,
  CODES.HIERARCHY_CYCLE,
  CODES.DUPLICATE_ID,
]);

const COLLECTION_REFERENCE = /^(nodes|edges|evidence|views|findings|decisions|migrationSlices|unknowns)\[(\d+)\](?:\.([A-Za-z0-9_]+(?:\[\d+\])?))?$/;
const KIND_BY_COLLECTION = Object.freeze({
  nodes: 'node',
  edges: 'edge',
  evidence: 'evidence',
  views: 'view',
  findings: 'finding',
  decisions: 'decision',
  migrationSlices: 'migrationSlice',
  unknowns: 'unknown',
});

// Keyed by the confidence enum value; a Map keeps a hostile value such as
// "constructor" from reaching the prototype chain.
const CONFIDENCE_RULES = new Map([
  ['low', {
    code: CODES.LOW_CONFIDENCE_FACT,
    message: 'is held with low confidence; it needs stronger evidence before it can be relied on.',
  }],
  ['unknown', {
    code: CODES.UNKNOWN_CONFIDENCE_FACT,
    message: 'has unknown confidence; the model does not say how well it is established.',
  }],
]);

const MAX_QUESTION_LENGTH = 120;

const LIMITATIONS = Object.freeze([
  'Computed from the model document alone; no source file, repository revision or artifact was read.',
  'Structural findings are limited to references and claims the model makes about itself; differences against source code are not inferred.',
  'Declared unknowns are reported as recorded gaps; this check does not resolve them.',
  'No clock is consulted, so nothing here states whether the model or its evidence is stale.',
]);

const UNVERIFIED_REASONS = Object.freeze([
  'sourceContentVerified=false: health reads the model document only and never compares it with the working tree.',
  'evidenceFreshness=unknown: judging freshness needs a source read or a comparable revision, and health performs neither.',
  'artifactFreshness=unknown: no diagram, report or export artifact was read or checked.',
]);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// Stable id of a declared record. Malformed entries are reported by the
// validator and skipped here rather than guessed.
function recordId(entry) {
  return isPlainObject(entry) && nonEmptyString(entry.id) ? entry.id : null;
}

function truncate(text) {
  return text.length <= MAX_QUESTION_LENGTH ? text : `${text.slice(0, MAX_QUESTION_LENGTH)}...`;
}

function target(kind, id, field) {
  return { kind, id, field };
}

function finding(code, category, severity, at, message) {
  return { code, category, severity, kind: at.kind, id: at.id, field: at.field, message };
}

function compareFindings(left, right) {
  return compareStrings(left.code, right.code)
    || compareStrings(left.kind, right.kind)
    || compareStrings(left.id === null ? '' : left.id, right.id === null ? '' : right.id)
    || compareStrings(left.field === null ? '' : left.field, right.field === null ? '' : right.field)
    || compareStrings(left.message, right.message);
}

// Maps a validator path such as "nodes[2].evidenceIds[0]" back to the fact it
// names. A path that does not name a declared record degrades to a model-level
// target instead of a wrong one.
function resolveTarget(document, path) {
  const match = typeof path === 'string' ? COLLECTION_REFERENCE.exec(path) : null;
  if (match === null) return target('model', null, nonEmptyString(path) ? path : null);
  const collection = match[1];
  const id = recordId(asArray(document[collection])[Number(match[2])]);
  if (id === null) return target('model', null, path);
  return target(KIND_BY_COLLECTION[collection], id, match[3] === undefined ? null : match[3]);
}

function classifyDiagnostic(document, diagnostic) {
  const category = CONFLICT_CODES.includes(diagnostic.code) ? CATEGORY_CONFLICTS : CATEGORY_CONTRACT;
  return finding(diagnostic.code, category, SEVERITY_ERROR, resolveTarget(document, diagnostic.path), diagnostic.message);
}

function coverageFindings(document) {
  const coverage = isPlainObject(document.coverage) ? document.coverage : null;
  if (coverage === null || coverage.complete !== false) return [];
  return [finding(
    CODES.COVERAGE_INCOMPLETE,
    CATEGORY_COVERAGE,
    SEVERITY_WARNING,
    target('model', null, 'coverage.complete'),
    'coverage.complete is false: the scan did not cover the whole declared scope, so the model is not a complete picture.',
  )];
}

function unknownFindings(document) {
  const findings = [];
  for (const entry of asArray(document.unknowns)) {
    const id = recordId(entry);
    if (id === null) continue;
    const question = nonEmptyString(entry.question) ? entry.question.trim() : null;
    findings.push(finding(
      CODES.DECLARED_UNKNOWN,
      CATEGORY_UNKNOWNS,
      SEVERITY_INFO,
      target('unknown', id, 'question'),
      question === null
        ? `Unknown "${id}" is declared and still unresolved.`
        : `Unknown "${id}" is declared and still unresolved: ${truncate(question)}`,
    ));
  }
  return findings;
}

function evidenceFindings(document) {
  const findings = [];
  for (const [collection, label] of [['nodes', 'Node'], ['edges', 'Edge']]) {
    for (const entry of asArray(document[collection])) {
      const id = recordId(entry);
      if (id === null) continue;
      if (!Array.isArray(entry.evidenceIds) || entry.evidenceIds.length > 0) continue;
      findings.push(finding(
        CODES.MISSING_EVIDENCE,
        CATEGORY_EVIDENCE,
        SEVERITY_WARNING,
        target(KIND_BY_COLLECTION[collection], id, 'evidenceIds'),
        `${label} "${id}" declares no evidence at all; nothing in the model supports it.`,
      ));
    }
  }
  return findings;
}

function confidenceFindings(document) {
  const findings = [];
  for (const [collection, label] of [['nodes', 'Node'], ['edges', 'Edge']]) {
    for (const entry of asArray(document[collection])) {
      const id = recordId(entry);
      if (id === null) continue;
      const rule = CONFIDENCE_RULES.get(entry.confidence);
      if (rule === undefined) continue;
      findings.push(finding(
        rule.code,
        CATEGORY_CONFIDENCE,
        SEVERITY_WARNING,
        target(KIND_BY_COLLECTION[collection], id, 'confidence'),
        `${label} "${id}" ${rule.message}`,
      ));
    }
  }
  return findings;
}

function countFindings(findings) {
  const counts = { findings: findings.length, errors: 0, warnings: 0, infos: 0, byCategory: {} };
  for (const category of CATEGORIES) counts.byCategory[category] = 0;
  for (const item of findings) {
    if (item.severity === SEVERITY_ERROR) counts.errors += 1;
    else if (item.severity === SEVERITY_WARNING) counts.warnings += 1;
    else counts.infos += 1;
    if (Object.prototype.hasOwnProperty.call(counts.byCategory, item.category)) counts.byCategory[item.category] += 1;
  }
  return counts;
}

function describeDocument(document) {
  const project = isPlainObject(document.project) ? document.project : {};
  const coverage = isPlainObject(document.coverage) ? document.coverage : {};
  return {
    projectId: nonEmptyString(project.id) ? project.id : null,
    schemaVersion: Number.isInteger(document.schemaVersion) ? document.schemaVersion : null,
    generatedAt: nonEmptyString(document.generatedAt) ? document.generatedAt : null,
    sourceRevision: nonEmptyString(document.sourceRevision) ? document.sourceRevision : null,
    coverage: {
      filesScanned: Number.isInteger(coverage.filesScanned) && coverage.filesScanned >= 0 ? coverage.filesScanned : null,
      complete: typeof coverage.complete === 'boolean' ? coverage.complete : null,
    },
  };
}

function unverifiedBlock() {
  return {
    sourceContentVerified: false,
    evidenceFreshness: 'unknown',
    artifactFreshness: 'unknown',
    reasons: [...UNVERIFIED_REASONS],
  };
}

function internalFailure() {
  const diagnostic = {
    code: CODES.INTERNAL_ERROR,
    path: '',
    message: 'Health check failed on unexpected input; no claim about the model was made.',
  };
  const findings = [finding(
    diagnostic.code,
    CATEGORY_CONTRACT,
    SEVERITY_ERROR,
    target('model', null, null),
    diagnostic.message,
  )];
  return {
    ok: false,
    model: describeDocument({}),
    validation: { valid: false, schemaVersion: null, diagnostics: [diagnostic], summary: { nodes: 0, edges: 0, evidence: 0 } },
    findings,
    counts: countFindings(findings),
    unverified: unverifiedBlock(),
    limitations: [...LIMITATIONS],
  };
}

/**
 * Runs the architecture health check on one model value.
 *
 * Never throws and never mutates its input: malformed, unsupported or hostile
 * input yields ok=false with an internal_error finding instead. validateModel()
 * runs first, so every structural rule keeps a single source of truth; its
 * diagnostics are carried verbatim in validation and split into "contract" and
 * "conflicts" findings. ok mirrors validation.valid, so a model that satisfies
 * the v1 contract still reports its gaps as findings.
 *
 * @param {unknown} model Parsed JSON value, not necessarily a v1 model object.
 * @returns {{ok: boolean, model: object, validation: object, findings: Array<{code: string, category: string, severity: string, kind: string, id: string|null, field: string|null, message: string}>, counts: object, unverified: {sourceContentVerified: boolean, evidenceFreshness: string, artifactFreshness: string, reasons: Array<string>}, limitations: Array<string>}}
 */
function healthCheck(model) {
  try {
    const document = isPlainObject(model) ? model : {};
    const validation = validateModel(model);
    const findings = [
      ...validation.diagnostics.map((diagnostic) => classifyDiagnostic(document, diagnostic)),
      ...coverageFindings(document),
      ...unknownFindings(document),
      ...evidenceFindings(document),
      ...confidenceFindings(document),
    ].sort(compareFindings);

    return {
      ok: validation.valid,
      model: describeDocument(document),
      validation,
      findings,
      counts: countFindings(findings),
      unverified: unverifiedBlock(),
      limitations: [...LIMITATIONS],
    };
  } catch {
    return internalFailure();
  }
}

module.exports = { healthCheck, CATEGORIES, LIMITATIONS };
