'use strict';

const { validateModel } = require('./validation');
const { CODES } = require('./error-codes');
const { compareStrings } = require('./compare-strings');

// Answers one question from file paths alone: does a declared model still
// describe the workspace it claims to describe? It never reads Git, file
// content, or the clock, never mutates its inputs, and never throws. Absence is
// only proof when the enumeration was complete, so an incomplete scan downgrades
// a missing path to "existence unknown" instead of asserting the file is gone.
// Mirrors export-preview.js: the v1 contract failure is reported with the
// lowercase literal, because error-codes.js has no invalid_model entry and a
// code is protocol that must not be invented.
const INVALID_MODEL = 'invalid_model';
const DEFAULT_MAX_FINDINGS = 100;
const MAX_FINDINGS_LIMIT = 1000;

const LIMIT_NO_GIT = 'no git state was read, so a file that still exists and is still cited may have changed without this check noticing';
const LIMIT_NO_CONTENT = 'no source file content was read, so freshness is decided by path presence only';
const EXISTENCE_UNKNOWN_REASON = 'the workspace enumeration was incomplete, so a missing path is not evidence that the file is gone';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

// Message helpers never serialize a value: a cyclic or hostile input must not be
// able to turn a diagnostic into a throw.
function describe(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `the string ${JSON.stringify(value)}`;
  if (typeof value === 'object') return 'an object';
  return String(value);
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function baseLimits() {
  return [LIMIT_NO_GIT, LIMIT_NO_CONTENT];
}

function failure(code, message, extra) {
  return { ok: false, error: { code, message }, ...(extra || {}), limits: baseLimits() };
}

function validateObserved(observed) {
  if (!isPlainObject(observed)) return `"observed" must be a plain object; received ${describe(observed)}.`;
  if (!isStringArray(observed.enumerated)) return '"observed.enumerated" must be an array of strings.';
  if (!isStringArray(observed.modelled)) return '"observed.modelled" must be an array of strings.';
  if (typeof observed.complete !== 'boolean') return '"observed.complete" must be a boolean.';
  if (hasOwn(observed, 'limits') && observed.limits !== undefined && !Array.isArray(observed.limits)) {
    return '"observed.limits" must be an array when present.';
  }
  return null;
}

// Maps each evidence id to the set of node/edge ids that cite it; a repeated
// evidenceIds entry cannot inflate the citation list.
function collectCitations(records, target) {
  if (!Array.isArray(records)) return;
  for (const record of records) {
    if (!isPlainObject(record) || typeof record.id !== 'string') continue;
    const refs = Array.isArray(record.evidenceIds) ? record.evidenceIds : [];
    for (const evidenceId of refs) {
      if (!isNonEmptyString(evidenceId)) continue;
      if (!target.has(evidenceId)) target.set(evidenceId, new Set());
      target.get(evidenceId).add(record.id);
    }
  }
}

function sortedFrom(set) {
  return set ? Array.from(set).sort(compareStrings) : [];
}

function recordedLimitCodes(limits) {
  if (!Array.isArray(limits)) return [];
  const codes = new Set();
  for (const entry of limits) {
    if (isPlainObject(entry) && isNonEmptyString(entry.code)) codes.add(entry.code);
  }
  return Array.from(codes).sort(compareStrings);
}

function capList(list, max) {
  return list.length > max ? list.slice(0, max) : list;
}

function buildLimits(context) {
  const { observed, truncated, omitted, maxFindings, evaluatedEvidence } = context;
  const limits = baseLimits();
  if (observed.enumerated.length === 0) {
    limits.push('the workspace scan enumerated no paths, so this result describes an empty scan rather than a verified workspace');
  }
  if (evaluatedEvidence === 0) {
    limits.push('the declared model cites no file paths, so there is nothing to verify against the workspace');
  }
  if (observed.complete === false) {
    const codes = recordedLimitCodes(observed.limits);
    limits.push(codes.length > 0
      ? `the workspace enumeration was incomplete; recorded limit codes: ${codes.join(', ')}`
      : 'the workspace enumeration was incomplete and no specific limit codes were recorded');
  }
  if (truncated) {
    const parts = [
      ['missingEvidence', omitted.missingEvidence],
      ['noLongerModelled', omitted.noLongerModelled],
      ['unmodelledPaths', omitted.unmodelledPaths],
      ['existenceUnknown', omitted.existenceUnknown],
    ].filter(([, count]) => count > 0).map(([name, count]) => `${name}=${count}`);
    limits.push(parts.length > 0
      ? `findings were truncated at maxFindings=${maxFindings} per list; omitted: ${parts.join(', ')}`
      : `findings were truncated at maxFindings=${maxFindings} per list`);
  }
  return limits;
}

function assess(model, observed, maxFindings) {
  const enumeratedSet = new Set(observed.enumerated);
  const modelledSet = new Set(observed.modelled);
  const complete = observed.complete;

  const nodeCitations = new Map();
  const edgeCitations = new Map();
  collectCitations(model.nodes, nodeCitations);
  collectCitations(model.edges, edgeCitations);

  const evidence = Array.isArray(model.evidence) ? model.evidence : [];
  const citedPaths = new Set();
  const missingEvidence = [];
  const noLongerModelled = [];
  const existenceUnknown = [];
  let pathlessEvidence = 0;

  for (const entry of evidence) {
    if (!isPlainObject(entry) || !isNonEmptyString(entry.path)) {
      pathlessEvidence += 1;
      continue;
    }
    const path = entry.path;
    const evidenceId = typeof entry.id === 'string' ? entry.id : '';
    citedPaths.add(path);
    const finding = {
      evidenceId,
      path,
      nodeIds: sortedFrom(nodeCitations.get(evidenceId)),
      edgeIds: sortedFrom(edgeCitations.get(evidenceId)),
    };
    const inEnumerated = enumeratedSet.has(path);
    if (!inEnumerated) {
      if (complete) missingEvidence.push(finding);
      else existenceUnknown.push({ ...finding, reason: EXISTENCE_UNKNOWN_REASON });
    } else if (!modelledSet.has(path)) {
      noLongerModelled.push(finding);
    }
  }

  const unmodelledPaths = [];
  const seenUnmodelled = new Set();
  for (const path of observed.modelled) {
    if (citedPaths.has(path) || seenUnmodelled.has(path)) continue;
    seenUnmodelled.add(path);
    unmodelledPaths.push({ path });
  }
  unmodelledPaths.sort((left, right) => compareStrings(left.path, right.path));

  const byEvidenceId = (left, right) => compareStrings(left.evidenceId, right.evidenceId);
  missingEvidence.sort(byEvidenceId);
  noLongerModelled.sort(byEvidenceId);
  existenceUnknown.sort(byEvidenceId);

  const evaluatedEvidence = evidence.length - pathlessEvidence;

  let verdict;
  if (observed.enumerated.length === 0) verdict = 'incomplete';
  else if (missingEvidence.length > 0 || noLongerModelled.length > 0) verdict = 'drifted';
  else if (existenceUnknown.length > 0) verdict = 'incomplete';
  else if (evaluatedEvidence === 0) verdict = 'incomplete';
  else verdict = 'aligned';

  const capped = {
    missingEvidence: capList(missingEvidence, maxFindings),
    noLongerModelled: capList(noLongerModelled, maxFindings),
    unmodelledPaths: capList(unmodelledPaths, maxFindings),
    existenceUnknown: capList(existenceUnknown, maxFindings),
  };
  const omitted = {
    missingEvidence: missingEvidence.length - capped.missingEvidence.length,
    noLongerModelled: noLongerModelled.length - capped.noLongerModelled.length,
    unmodelledPaths: unmodelledPaths.length - capped.unmodelledPaths.length,
    existenceUnknown: existenceUnknown.length - capped.existenceUnknown.length,
  };
  const truncated = omitted.missingEvidence > 0
    || omitted.noLongerModelled > 0
    || omitted.unmodelledPaths > 0
    || omitted.existenceUnknown > 0;

  return {
    ok: true,
    verdict,
    findings: capped,
    counts: {
      evidence: evidence.length,
      missingEvidence: missingEvidence.length,
      noLongerModelled: noLongerModelled.length,
      unmodelledPaths: unmodelledPaths.length,
      existenceUnknown: existenceUnknown.length,
      enumerated: observed.enumerated.length,
      modelled: observed.modelled.length,
      pathlessEvidence,
    },
    truncated,
    omitted,
    limits: buildLimits({ observed, truncated, omitted, maxFindings, evaluatedEvidence }),
  };
}

function run(input) {
  const request = isPlainObject(input) ? input : {};

  const model = request.model;
  if (!isPlainObject(model)) {
    return failure(INVALID_MODEL, `A model object is required; received ${describe(model)}.`);
  }
  const validation = validateModel(model);
  if (!validation.valid) {
    return failure(INVALID_MODEL, 'The model failed structural validation; drift was not assessed.', { validation });
  }

  const observedProblem = validateObserved(request.observed);
  if (observedProblem !== null) {
    return failure(CODES.INVALID_OPTION, observedProblem);
  }

  let maxFindings = DEFAULT_MAX_FINDINGS;
  if (hasOwn(request, 'maxFindings') && request.maxFindings !== undefined) {
    const value = request.maxFindings;
    if (!isPositiveInteger(value) || value > MAX_FINDINGS_LIMIT) {
      return failure(CODES.INVALID_OPTION, `"maxFindings" must be an integer in 1..${MAX_FINDINGS_LIMIT}; received ${describe(value)}.`);
    }
    maxFindings = value;
  }

  return assess(model, request.observed, maxFindings);
}

/**
 * Assesses whether a declared v1 model still describes the workspace it claims.
 *
 * Never throws: any input, including garbage, yields a structured failure. An
 * absent path is only counted as missing evidence when the enumeration was
 * complete; an incomplete scan reports it as existenceUnknown instead.
 *
 * @param {{model?: object, observed?: object, maxFindings?: number}} input
 * @returns {{ok: boolean, error?: {code: string, message: string}, validation?: object, verdict?: string, findings?: object, counts?: object, truncated?: boolean, omitted?: object, limits: string[]}}
 */
function computeDrift(input) {
  try {
    return run(input);
  } catch (error) {
    return failure(CODES.INTERNAL_ERROR, `Drift assessment failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

module.exports = { computeDrift };
