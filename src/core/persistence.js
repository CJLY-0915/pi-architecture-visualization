'use strict';

const crypto = require('node:crypto');
const { validateModel } = require('./validation');
const { CODES } = require('./error-codes');
const { compareStrings } = require('./compare-strings');

const SNAPSHOT_DIRECTORY = 'architecture/snapshots';
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const ID_SORTED_COLLECTIONS = new Set([
  'nodes', 'edges', 'evidence', 'views', 'findings', 'decisions', 'migrationSlices', 'unknowns',
]);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalizeArray(items, field, ancestors) {
  const canonical = items.map((item) => canonicalizeValue(item, '', ancestors));
  if (field === 'evidenceIds' || field === 'scope.roots') {
    const unique = new Map();
    for (const item of canonical) unique.set(JSON.stringify(item), item);
    return [...unique.entries()]
      .sort(([leftKey, left], [rightKey, right]) => compareStrings(
        typeof left === 'string' ? left : leftKey,
        typeof right === 'string' ? right : rightKey,
      ))
      .map(([, item]) => item);
  }
  if (ID_SORTED_COLLECTIONS.has(field)) {
    return canonical.sort((left, right) => compareStrings(
      isPlainObject(left) && typeof left.id === 'string' ? left.id : JSON.stringify(left),
      isPlainObject(right) && typeof right.id === 'string' ? right.id : JSON.stringify(right),
    ));
  }
  return canonical;
}

function canonicalizeValue(value, field, ancestors) {
  if (Array.isArray(value)) return canonicalizeArray(value, field, ancestors);
  if (!isPlainObject(value)) return value;
  if (ancestors.has(value)) throw new TypeError('Circular snapshot input.');

  ancestors.add(value);
  try {
    const result = {};
    for (const key of Object.keys(value).sort(compareStrings)) {
      result[key] = canonicalizeValue(value[key], field === 'scope' ? `scope.${key}` : key, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Returns a non-mutating canonical copy of an architecture model.
 */
function canonicalizeModel(model) {
  return canonicalizeValue(model, '', new Set());
}

function fingerprintText(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function snapshotPath(fingerprint) {
  if (typeof fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(fingerprint)) return null;
  return `${SNAPSHOT_DIRECTORY}/${fingerprint}.json`;
}

function validationForMissingModel() {
  return validateModel(undefined);
}

function failure(validation, code, path, message) {
  return { ok: false, validation, error: { code, path, message } };
}

function isJsonCompatible(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;

  ancestors.add(value);
  try {
    const entries = Array.isArray(value) ? value.entries() : Object.keys(value).map((key) => [key, value[key]]);
    for (const [, item] of entries) {
      if (!isJsonCompatible(item, ancestors)) return false;
    }
    return true;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Plans an immutable, content-addressed architecture snapshot. It does not
 * perform I/O and never selects a mutable model path.
 */
function planSnapshotSave(input) {
  let validation = validationForMissingModel();
  try {
    if (!isPlainObject(input) || !Object.prototype.hasOwnProperty.call(input, 'model')) {
      return failure(validation, CODES.INVALID_OPTION, 'model', 'A snapshot save request with a model is required.');
    }

    const model = input.model;
    validation = validateModel(model);
    if (!validation.valid) {
      return failure(validation, CODES.UNSUPPORTED_INPUT, 'model', 'A valid architecture model is required for a snapshot.');
    }
    if (!isJsonCompatible(model)) {
      return failure(validation, CODES.UNSUPPORTED_INPUT, 'model', 'Snapshot input must contain only finite JSON values without cycles.');
    }

    const text = `${JSON.stringify(canonicalizeModel(model))}\n`;
    const fingerprint = fingerprintText(text);
    const path = snapshotPath(fingerprint);
    if (path === null) {
      return failure(validation, CODES.INTERNAL_ERROR, '', 'Snapshot planning failed unexpectedly.');
    }

    return {
      ok: true,
      fingerprint,
      text,
      path,
      metadata: {
        schemaVersion: model.schemaVersion,
        projectId: model.project.id,
        sourceRevision: model.sourceRevision,
        generatedAt: model.generatedAt,
      },
      validation,
    };
  } catch {
    return failure(validation, CODES.INTERNAL_ERROR, '', 'Snapshot planning failed unexpectedly.');
  }
}

module.exports = {
  canonicalizeModel,
  fingerprintText,
  snapshotPath,
  planSnapshotSave,
};
