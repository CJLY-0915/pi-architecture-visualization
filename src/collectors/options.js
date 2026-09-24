'use strict';

const { CODES } = require('../core/error-codes');

// Option normalization for the read-only collector.
//
// Normalization is total: an unusable option produces an invalid_option
// diagnostic plus a safe fallback value, so callers always receive a
// structurally valid v1 model. No fallback uses the current time: a missing or
// malformed generatedAt falls back to a fixed epoch constant, never to "now".
// The only wall-clock use anywhere in the collectors is the default `now`
// function, which the frozen interface defines as () => Date.now() and which is
// consulted for the timeout comparison only.

const DEFAULTS = Object.freeze({
  maxFiles: 500,
  maxFileChars: 200000,
  totalCharBudget: 4000000,
  timeoutMs: 15000,
});

const DEFAULT_SCOPE_ROOTS = Object.freeze(['.']);
const FALLBACK_PROJECT_ID = 'unknown-project';
const FALLBACK_GENERATED_AT = '1970-01-01T00:00:00Z';

const ISO_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const DRIVE_LETTER_PATTERN = /^[A-Za-z]:/;
const NUMERIC_OPTIONS = Object.freeze([
  ['maxFiles', DEFAULTS.maxFiles],
  ['maxFileChars', DEFAULTS.maxFileChars],
  ['totalCharBudget', DEFAULTS.totalCharBudget],
  ['timeoutMs', DEFAULTS.timeoutMs],
]);

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function describe(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `the string ${JSON.stringify(value)}`;
  if (typeof value === 'object') return 'an object';
  return String(value);
}

function isValidIsoDateTime(value) {
  return typeof value === 'string' && ISO_DATETIME_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

// Returns null for an acceptable scope root, otherwise a short reason. "." is
// allowed (whole workspace) and is dropped from the normalized root, mirroring
// the validator's own scope-root rules.
function scopeRootViolation(value) {
  if (typeof value !== 'string') return 'not_a_string';
  if (value.trim() === '') return 'empty';
  if (value.includes('\\')) return 'backslash_separator';
  if (value.startsWith('/') || DRIVE_LETTER_PATTERN.test(value)) return 'absolute_path';
  for (const segment of value.split('/')) {
    if (segment === '') return 'empty_segment';
    if (segment === '..') return 'parent_segment';
  }
  return null;
}

function normalizeScopeRoot(root) {
  const segments = root.split('/').filter((segment) => segment !== '.');
  return segments.length === 0 ? '.' : segments.join('/');
}

function normalizeNumericOptions(options, invalid) {
  const resolved = Object.assign({}, DEFAULTS);
  for (const [name, fallback] of NUMERIC_OPTIONS) {
    if (!hasOwn(options, name) || options[name] === undefined) continue;
    if (!isPositiveInteger(options[name])) {
      invalid(`options.${name}`, `"options.${name}" must be a positive integer, received ${describe(options[name])}.`);
      resolved[name] = fallback;
      continue;
    }
    resolved[name] = options[name];
  }
  return resolved;
}
function normalizeScopeRoots(options, diagnostics, invalid) {
  if (!hasOwn(options, 'scopeRoots') || options.scopeRoots === undefined) return DEFAULT_SCOPE_ROOTS;
  const raw = options.scopeRoots;
  if (!Array.isArray(raw) || raw.length === 0) {
    invalid('options.scopeRoots', `"options.scopeRoots" must be a non-empty array of relative POSIX paths, received ${describe(raw)}.`);
    return DEFAULT_SCOPE_ROOTS;
  }
  const roots = [];
  let usable = true;
  raw.forEach((root, index) => {
    const violation = scopeRootViolation(root);
    if (violation !== null) {
      usable = false;
      invalid(`options.scopeRoots[${index}]`,
        `Invalid scope root (${violation}): ${describe(root)}. Roots must be relative POSIX paths without backslashes, drive letters or ".." segments; "." is allowed.`);
      return;
    }
    roots.push(normalizeScopeRoot(root));
  });
  return usable ? roots : DEFAULT_SCOPE_ROOTS;
}

/**
 * Normalizes collector options and reports every rejected field.
 *
 * @param {unknown} rawOptions Caller-supplied options object; anything else is
 *   treated as an empty object so the missing required fields are reported.
 * @returns {{ok: boolean, diagnostics: Array<{code: string, path: string, message: string}>, projectId: string, generatedAt: string, sourceRevision: string|null, scopeRoots: string[], maxFiles: number, maxFileChars: number, totalCharBudget: number, timeoutMs: number, now: () => number}}
 */
function normalizeCollectOptions(rawOptions) {
  const diagnostics = [];
  const options = isPlainObject(rawOptions) ? rawOptions : {};
  const invalid = (path, message) => diagnostics.push({ code: CODES.INVALID_OPTION, path, message });

  let projectId = FALLBACK_PROJECT_ID;
  if (typeof options.projectId !== 'string' || options.projectId.trim() === '') {
    invalid('options.projectId', `"options.projectId" must be a non-empty string, received ${describe(options.projectId)}.`);
  } else {
    projectId = options.projectId;
  }

  let generatedAt = FALLBACK_GENERATED_AT;
  if (!isValidIsoDateTime(options.generatedAt)) {
    invalid('options.generatedAt',
      `"options.generatedAt" must be an ISO 8601 date-time with a timezone (for example 2024-05-01T09:30:00Z), received ${describe(options.generatedAt)}.`);
  } else {
    generatedAt = options.generatedAt;
  }

  let sourceRevision = null;
  if (hasOwn(options, 'sourceRevision') && options.sourceRevision !== undefined && options.sourceRevision !== null) {
    if (typeof options.sourceRevision !== 'string' || options.sourceRevision.trim() === '') {
      invalid('options.sourceRevision', `"options.sourceRevision" must be a non-empty string or null, received ${describe(options.sourceRevision)}.`);
    } else {
      sourceRevision = options.sourceRevision;
    }
  }

  // A display name is optional: the model keeps `project.id` as the stable
  // identity and only carries `name` when the caller supplies a human-readable
  // one. Omitting it leaves the object exactly as it was.
  let projectName = null;
  if (hasOwn(options, 'projectName') && options.projectName !== undefined && options.projectName !== null) {
    if (typeof options.projectName !== 'string' || options.projectName.trim() === '') {
      invalid('options.projectName', `"options.projectName" must be a non-empty string or null, received ${describe(options.projectName)}.`);
    } else {
      projectName = options.projectName;
    }
  }

  const scopeRoots = normalizeScopeRoots(options, diagnostics, invalid);

  const numeric = normalizeNumericOptions(options, invalid);

  let now = () => Date.now();
  if (hasOwn(options, 'now') && options.now !== undefined) {
    if (typeof options.now !== 'function') {
      invalid('options.now', `"options.now" must be a function returning milliseconds, received ${describe(options.now)}.`);
    } else {
      now = options.now;
    }
  }

  return {
    diagnostics,
    projectId,
    projectName,
    generatedAt,
    sourceRevision,
    scopeRoots,
    maxFiles: numeric.maxFiles,
    maxFileChars: numeric.maxFileChars,
    totalCharBudget: numeric.totalCharBudget,
    timeoutMs: numeric.timeoutMs,
    now,
  };
}

module.exports = { normalizeCollectOptions };
