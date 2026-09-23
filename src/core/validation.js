'use strict';

// Architecture model v1 validator.
// schemas/architecture-model.schema.json documents structure only; enums,
// id uniqueness, reference integrity, hierarchy cycles, evidence scope
// containment, confirmed-fact evidence and edge state consistency are semantic
// rules enforced here. Enums in both files must stay in sync.
//
// validateModel() is pure: it never throws for any JSON input and returns a
// fresh result. Diagnostics are emitted in a fixed check order (root fields ->
// collection presence -> generic id collections -> evidence -> nodes -> edges
// -> hierarchy), so identical input always produces identical diagnostics.

const { CODES } = require('./error-codes');

const SUPPORTED_SCHEMA_VERSION = 1;

const NODE_TYPES = Object.freeze(['actor', 'system', 'container', 'component', 'module', 'datastore', 'external']);
const RELATION_TYPES = Object.freeze(['depends_on', 'calls', 'reads', 'writes', 'publishes', 'subscribes', 'contains']);
const STATES = Object.freeze(['current', 'target', 'runtime']);
const STATUSES = Object.freeze(['confirmed', 'inferred', 'assumed', 'unknown']);
const CONFIDENCES = Object.freeze(['high', 'medium', 'low', 'unknown']);
const EVIDENCE_TYPES = Object.freeze(['code', 'config', 'schema', 'iac', 'runtime', 'document', 'test']);

const ID_COLLECTIONS = Object.freeze(['nodes', 'edges', 'evidence', 'views', 'findings', 'decisions', 'migrationSlices', 'unknowns']);
const GENERIC_ID_COLLECTIONS = Object.freeze(['views', 'findings', 'decisions', 'migrationSlices', 'unknowns']);

const ISO_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const DRIVE_LETTER_PATTERN = /^[A-Za-z]:/;
const MAX_QUOTED_LENGTH = 60;

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonNegativeInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isValidIsoDateTime(value) {
  return typeof value === 'string' && ISO_DATETIME_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

function truncate(text) {
  return text.length <= MAX_QUOTED_LENGTH ? text : `${text.slice(0, MAX_QUOTED_LENGTH)}...`;
}

function describeValue(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `the string ${truncate(JSON.stringify(value))}`;
  if (typeof value === 'object') return 'an object';
  return String(value);
}

function push(diagnostics, code, path, message) {
  diagnostics.push({ code, path, message });
}

// Returns null for an acceptable relative POSIX path, otherwise a short reason
// used in the diagnostic message. Dot segments are rejected for evidence paths;
// scope roots may use "." (whole project) but never "..".
function describeRelativePathViolation(value, options) {
  const allowDotSegment = options !== undefined && options.allowDotSegment === true;
  if (typeof value !== 'string') return 'not_a_string';
  if (value.trim() === '') return 'empty';
  if (value.includes('\\')) return 'backslash_separator';
  if (value.startsWith('/') || DRIVE_LETTER_PATTERN.test(value)) return 'absolute_path';
  for (const segment of value.split('/')) {
    if (segment === '') return 'empty_segment';
    if (segment === '..') return 'parent_segment';
    if (segment === '.' && !allowDotSegment) return 'dot_segment';
  }
  return null;
}

function normalizeScopeRoot(root) {
  const segments = root.split('/').filter((segment) => segment !== '.');
  return segments.length === 0 ? '.' : segments.join('/');
}

function isWithinScopeRoot(evidencePath, root) {
  if (root === '.') return true;
  return evidencePath === root || evidencePath.startsWith(`${root}/`);
}

function requireNonEmptyString(value, path, diagnostics) {
  if (typeof value !== 'string') {
    push(diagnostics, CODES.INVALID_TYPE, path, `"${path}" must be a non-empty string, received ${describeValue(value)}.`);
    return false;
  }
  if (value.trim() === '') {
    push(diagnostics, CODES.EMPTY_STRING, path, `"${path}" must not be an empty or whitespace-only string.`);
    return false;
  }
  return true;
}

function requireNonEmptyStringField(container, field, path, diagnostics) {
  if (!hasOwn(container, field)) {
    push(diagnostics, CODES.MISSING_REQUIRED_FIELD, path, `Missing required field "${path}".`);
    return false;
  }
  return requireNonEmptyString(container[field], path, diagnostics);
}

// Returns the accepted value, or null when the field is missing or invalid.
function requireEnumField(container, field, path, allowed, diagnostics) {
  if (!hasOwn(container, field)) {
    push(diagnostics, CODES.MISSING_REQUIRED_FIELD, path, `Missing required field "${path}".`);
    return null;
  }
  const value = container[field];
  if (typeof value !== 'string' || !allowed.includes(value)) {
    push(diagnostics, CODES.INVALID_ENUM_VALUE, path, `"${path}" must be one of ${allowed.join('/')}, received ${describeValue(value)}.`);
    return null;
  }
  return value;
}

function registerId(seen, id, path, label, diagnostics) {
  if (seen.has(id)) {
    push(diagnostics, CODES.DUPLICATE_ID, path, `Duplicate ${label} id "${id}" (first declared at ${seen.get(id)}).`);
    return false;
  }
  seen.set(id, path);
  return true;
}

// Returns the array of references when it is a well-formed array, otherwise null
// so callers can skip reference checks already reported as a structural error.
function validateEvidenceIds(container, path, evidenceIds, diagnostics) {
  const fieldPath = `${path}.evidenceIds`;
  if (!hasOwn(container, 'evidenceIds')) {
    push(diagnostics, CODES.MISSING_REQUIRED_FIELD, fieldPath, `Missing required field "${fieldPath}".`);
    return null;
  }
  const refs = container.evidenceIds;
  if (!Array.isArray(refs)) {
    push(diagnostics, CODES.INVALID_TYPE, fieldPath, `"${fieldPath}" must be an array of evidence ids, received ${describeValue(refs)}.`);
    return null;
  }
  refs.forEach((ref, index) => {
    const refPath = `${fieldPath}[${index}]`;
    if (typeof ref !== 'string') {
      push(diagnostics, CODES.INVALID_TYPE, refPath, `"${refPath}" must be a non-empty evidence id string, received ${describeValue(ref)}.`);
      return;
    }
    if (ref.trim() === '') {
      push(diagnostics, CODES.EMPTY_STRING, refPath, `"${refPath}" must not be an empty evidence id.`);
      return;
    }
    if (!evidenceIds.has(ref)) {
      push(diagnostics, CODES.UNKNOWN_EVIDENCE_REFERENCE, refPath, `Evidence id "${ref}" is not declared in "evidence".`);
    }
  });
  return refs;
}

function countResolvedEvidence(refs, evidenceIds) {
  return refs.filter((ref) => evidenceIds.has(ref)).length;
}

function emptySummary() {
  return { nodes: 0, edges: 0, evidence: 0 };
}

/**
 * Validates an architecture model value against the v1 contract.
 *
 * Never throws: unexpected input (including hostile getters) yields
 * valid=false with an internal_error diagnostic. When schemaVersion is present
 * but unsupported, only version diagnostics are reported because the rest of
 * the document cannot be interpreted against an unknown contract.
 *
 * @param {unknown} value Parsed JSON value, not necessarily an object.
 * @returns {{valid: boolean, schemaVersion: number|null, diagnostics: Array<{code: string, path: string, message: string}>, summary: {nodes: number, edges: number, evidence: number}}}
 */
function validateModel(value) {
  try {
    return validateModelInternal(value);
  } catch {
    return {
      valid: false,
      schemaVersion: null,
      diagnostics: [{ code: CODES.INTERNAL_ERROR, path: '', message: 'Validator failed on unexpected input.' }],
      summary: emptySummary(),
    };
  }
}

function validateModelInternal(value) {
  const diagnostics = [];
  const summary = emptySummary();

  if (!isPlainObject(value)) {
    push(diagnostics, CODES.MODEL_NOT_OBJECT, '', `Model must be a JSON object, received ${describeValue(value)}.`);
    return { valid: false, schemaVersion: null, diagnostics, summary };
  }

  const version = validateSchemaVersion(value, diagnostics);
  if (!version.supported) {
    return { valid: false, schemaVersion: version.value, diagnostics, summary };
  }

  validateProject(value, diagnostics);
  const scopeRoots = validateScope(value, diagnostics);
  validateSourceRevision(value, diagnostics);
  validateGeneratedAt(value, diagnostics);
  validateCoverage(value, diagnostics);

  const collections = collectCollections(value, diagnostics, summary);
  validateGenericIdCollections(collections, diagnostics);
  const evidenceIds = validateEvidence(collections.evidence, scopeRoots, diagnostics);
  const nodeIndex = validateNodes(collections.nodes, evidenceIds, diagnostics);
  validateEdges(collections.edges, nodeIndex, evidenceIds, diagnostics);
  validateRuntimeEvidence(collections, diagnostics);
  validateHierarchy(collections.nodes, nodeIndex.ids, diagnostics);

  return { valid: diagnostics.length === 0, schemaVersion: version.value, diagnostics, summary };
}

function validateSchemaVersion(model, diagnostics) {
  if (!hasOwn(model, 'schemaVersion')) {
    push(diagnostics, CODES.MISSING_REQUIRED_FIELD, 'schemaVersion', 'Missing required field "schemaVersion".');
    return { value: null, supported: false };
  }
  const raw = model.schemaVersion;
  if (!Number.isInteger(raw)) {
    push(diagnostics, CODES.INVALID_SCHEMA_VERSION, 'schemaVersion', `"schemaVersion" must be an integer, received ${describeValue(raw)}.`);
    return { value: null, supported: false };
  }
  if (raw !== SUPPORTED_SCHEMA_VERSION) {
    push(diagnostics, CODES.UNSUPPORTED_SCHEMA_VERSION, 'schemaVersion',
      `Unsupported schemaVersion ${raw}; this validator supports schemaVersion ${SUPPORTED_SCHEMA_VERSION} only.`);
    return { value: raw, supported: false };
  }
  return { value: raw, supported: true };
}

function validateProject(model, diagnostics) {
  if (!hasOwn(model, 'project')) {
    push(diagnostics, CODES.MISSING_REQUIRED_FIELD, 'project', 'Missing required field "project".');
    return;
  }
  const project = model.project;
  if (!isPlainObject(project)) {
    push(diagnostics, CODES.INVALID_TYPE, 'project', `"project" must be an object, received ${describeValue(project)}.`);
    return;
  }
  requireNonEmptyStringField(project, 'id', 'project.id', diagnostics);
}

// Returns the normalized scope roots; containment checks are skipped when no
// root is valid because the scope diagnostics already explain the failure.
function validateScope(model, diagnostics) {
  if (!hasOwn(model, 'scope')) {
    push(diagnostics, CODES.MISSING_REQUIRED_FIELD, 'scope', 'Missing required field "scope".');
    return [];
  }
  const scope = model.scope;
  if (!isPlainObject(scope)) {
    push(diagnostics, CODES.INVALID_TYPE, 'scope', `"scope" must be an object, received ${describeValue(scope)}.`);
    return [];
  }
  if (!hasOwn(scope, 'roots')) {
    push(diagnostics, CODES.MISSING_REQUIRED_FIELD, 'scope.roots', 'Missing required field "scope.roots".');
    return [];
  }
  const rawRoots = scope.roots;
  if (!Array.isArray(rawRoots)) {
    push(diagnostics, CODES.INVALID_TYPE, 'scope.roots', `"scope.roots" must be an array of relative paths, received ${describeValue(rawRoots)}.`);
    return [];
  }
  if (rawRoots.length === 0) {
    push(diagnostics, CODES.INVALID_SCOPE_ROOT, 'scope.roots', '"scope.roots" must declare at least one relative path root.');
    return [];
  }

  const roots = [];
  rawRoots.forEach((root, index) => {
    const path = `scope.roots[${index}]`;
    const violation = describeRelativePathViolation(root, { allowDotSegment: true });
    if (violation !== null) {
      push(diagnostics, CODES.INVALID_SCOPE_ROOT, path,
        `Invalid scope root (${violation}): ${describeValue(root)}. Roots must be relative POSIX paths without backslashes, drive letters or ".." segments; "." is allowed.`);
      return;
    }
    roots.push(normalizeScopeRoot(root));
  });
  return roots;
}

function validateSourceRevision(model, diagnostics) {
  if (!hasOwn(model, 'sourceRevision')) {
    push(diagnostics, CODES.MISSING_REQUIRED_FIELD, 'sourceRevision', 'Missing required field "sourceRevision" (use null when the revision is unknown).');
    return;
  }
  const revision = model.sourceRevision;
  if (revision === null) return;
  if (typeof revision !== 'string') {
    push(diagnostics, CODES.INVALID_TYPE, 'sourceRevision', `"sourceRevision" must be a string or null, received ${describeValue(revision)}.`);
    return;
  }
  if (revision.trim() === '') {
    push(diagnostics, CODES.EMPTY_STRING, 'sourceRevision', '"sourceRevision" must be null or a non-empty string.');
  }
}

function validateGeneratedAt(model, diagnostics) {
  if (!hasOwn(model, 'generatedAt')) {
    push(diagnostics, CODES.MISSING_REQUIRED_FIELD, 'generatedAt', 'Missing required field "generatedAt".');
    return;
  }
  if (!isValidIsoDateTime(model.generatedAt)) {
    push(diagnostics, CODES.INVALID_ISO_DATETIME, 'generatedAt',
      `"generatedAt" must be an ISO 8601 date-time with a timezone (for example 2024-05-01T09:30:00Z), received ${describeValue(model.generatedAt)}.`);
  }
}

function validateCoverage(model, diagnostics) {
  if (!hasOwn(model, 'coverage')) {
    push(diagnostics, CODES.MISSING_REQUIRED_FIELD, 'coverage', 'Missing required field "coverage".');
    return;
  }
  const coverage = model.coverage;
  if (!isPlainObject(coverage)) {
    push(diagnostics, CODES.INVALID_TYPE, 'coverage', `"coverage" must be an object, received ${describeValue(coverage)}.`);
    return;
  }
  if (!hasOwn(coverage, 'filesScanned')) {
    push(diagnostics, CODES.MISSING_REQUIRED_FIELD, 'coverage.filesScanned', 'Missing required field "coverage.filesScanned".');
  } else if (!isNonNegativeInteger(coverage.filesScanned)) {
    push(diagnostics, CODES.INVALID_NON_NEGATIVE_INTEGER, 'coverage.filesScanned',
      `"coverage.filesScanned" must be a non-negative integer, received ${describeValue(coverage.filesScanned)}.`);
  }
  if (!hasOwn(coverage, 'complete')) {
    push(diagnostics, CODES.MISSING_REQUIRED_FIELD, 'coverage.complete', 'Missing required field "coverage.complete".');
  } else if (typeof coverage.complete !== 'boolean') {
    push(diagnostics, CODES.INVALID_TYPE, 'coverage.complete', `"coverage.complete" must be a boolean, received ${describeValue(coverage.complete)}.`);
  }
}

function collectCollections(model, diagnostics, summary) {
  const collections = {};
  for (const name of ID_COLLECTIONS) {
    if (!hasOwn(model, name)) {
      push(diagnostics, CODES.MISSING_REQUIRED_FIELD, name, `Missing required field "${name}".`);
      collections[name] = [];
      continue;
    }
    const items = model[name];
    if (!Array.isArray(items)) {
      push(diagnostics, CODES.INVALID_TYPE, name, `"${name}" must be an array, received ${describeValue(items)}.`);
      collections[name] = [];
      continue;
    }
    collections[name] = items;
  }
  summary.nodes = collections.nodes.length;
  summary.edges = collections.edges.length;
  summary.evidence = collections.evidence.length;
  return collections;
}

// v1 freezes detailed fields only for nodes, edges and evidence; the remaining
// arrays carry id-only objects until their contract is refined.
function validateGenericIdCollections(collections, diagnostics) {
  for (const name of GENERIC_ID_COLLECTIONS) {
    const seen = new Map();
    collections[name].forEach((item, index) => {
      const path = `${name}[${index}]`;
      if (!isPlainObject(item)) {
        push(diagnostics, CODES.INVALID_TYPE, path, `"${path}" must be an object, received ${describeValue(item)}.`);
        return;
      }
      const idPath = `${path}.id`;
      if (!hasOwn(item, 'id')) {
        push(diagnostics, CODES.MISSING_REQUIRED_FIELD, idPath, `Missing required field "${idPath}".`);
        return;
      }
      if (requireNonEmptyString(item.id, idPath, diagnostics)) {
        registerId(seen, item.id, idPath, name, diagnostics);
      }
    });
  }
}

function validateEvidence(items, scopeRoots, diagnostics) {
  const ids = new Set();
  const seen = new Map();

  items.forEach((item, index) => {
    const path = `evidence[${index}]`;
    if (!isPlainObject(item)) {
      push(diagnostics, CODES.INVALID_TYPE, path, `"${path}" must be an object, received ${describeValue(item)}.`);
      return;
    }

    const idPath = `${path}.id`;
    if (!hasOwn(item, 'id')) {
      push(diagnostics, CODES.MISSING_REQUIRED_FIELD, idPath, `Missing required field "${idPath}".`);
    } else if (requireNonEmptyString(item.id, idPath, diagnostics)) {
      if (registerId(seen, item.id, idPath, 'evidence', diagnostics)) ids.add(item.id);
    }

    const pathField = `${path}.path`;
    if (!hasOwn(item, 'path')) {
      push(diagnostics, CODES.MISSING_REQUIRED_FIELD, pathField, `Missing required field "${pathField}".`);
    } else {
      const violation = describeRelativePathViolation(item.path);
      if (violation !== null) {
        push(diagnostics, CODES.INVALID_EVIDENCE_PATH, pathField,
          `Invalid evidence path (${violation}): ${describeValue(item.path)}. Evidence paths must be relative POSIX paths without backslashes, drive letters, "." or ".." segments.`);
      } else if (scopeRoots.length > 0 && !scopeRoots.some((root) => isWithinScopeRoot(item.path, root))) {
        push(diagnostics, CODES.EVIDENCE_OUT_OF_SCOPE, pathField,
          `Evidence path "${item.path}" is outside scope roots [${scopeRoots.join(', ')}].`);
      }
    }

    requireEnumField(item, 'type', `${path}.type`, EVIDENCE_TYPES, diagnostics);

    if (hasOwn(item, 'line') && !isPositiveInteger(item.line)) {
      push(diagnostics, CODES.INVALID_POSITIVE_INTEGER, `${path}.line`,
        `"${path}.line" must be a positive integer when present, received ${describeValue(item.line)}.`);
    }
  });

  return ids;
}

function validateNodes(items, evidenceIds, diagnostics) {
  const ids = new Set();
  const stateById = new Map();
  const seen = new Map();

  items.forEach((item, index) => {
    const path = `nodes[${index}]`;
    if (!isPlainObject(item)) {
      push(diagnostics, CODES.INVALID_TYPE, path, `"${path}" must be an object, received ${describeValue(item)}.`);
      return;
    }

    const idPath = `${path}.id`;
    if (!hasOwn(item, 'id')) {
      push(diagnostics, CODES.MISSING_REQUIRED_FIELD, idPath, `Missing required field "${idPath}".`);
    } else if (requireNonEmptyString(item.id, idPath, diagnostics)) {
      if (registerId(seen, item.id, idPath, 'node', diagnostics)) ids.add(item.id);
    }

    requireNonEmptyStringField(item, 'name', `${path}.name`, diagnostics);
    requireEnumField(item, 'type', `${path}.type`, NODE_TYPES, diagnostics);
    const state = requireEnumField(item, 'state', `${path}.state`, STATES, diagnostics);
    const status = requireEnumField(item, 'status', `${path}.status`, STATUSES, diagnostics);
    requireEnumField(item, 'confidence', `${path}.confidence`, CONFIDENCES, diagnostics);
    const evidenceRefs = validateEvidenceIds(item, path, evidenceIds, diagnostics);

    if (hasOwn(item, 'parentId')) {
      requireNonEmptyString(item.parentId, `${path}.parentId`, diagnostics);
    }

    if (typeof item.id === 'string' && item.id !== '' && typeof state === 'string' && !stateById.has(item.id)) {
      stateById.set(item.id, state);
    }

    if (status === 'confirmed' && evidenceRefs !== null && countResolvedEvidence(evidenceRefs, evidenceIds) === 0) {
      push(diagnostics, CODES.UNPROVEN_CONFIRMED_FACT, `${path}.evidenceIds`,
        `Node "${item.id}" is confirmed but references no declared evidence; confirmed facts require at least one evidence entry.`);
    }
  });

  return { ids, stateById };
}

function validateEdges(items, nodeIndex, evidenceIds, diagnostics) {
  const seen = new Map();

  items.forEach((item, index) => {
    const path = `edges[${index}]`;
    if (!isPlainObject(item)) {
      push(diagnostics, CODES.INVALID_TYPE, path, `"${path}" must be an object, received ${describeValue(item)}.`);
      return;
    }

    const idPath = `${path}.id`;
    if (!hasOwn(item, 'id')) {
      push(diagnostics, CODES.MISSING_REQUIRED_FIELD, idPath, `Missing required field "${idPath}".`);
    } else if (requireNonEmptyString(item.id, idPath, diagnostics)) {
      registerId(seen, item.id, idPath, 'edge', diagnostics);
    }

    const hasSource = requireNonEmptyStringField(item, 'source', `${path}.source`, diagnostics);
    const hasTarget = requireNonEmptyStringField(item, 'target', `${path}.target`, diagnostics);
    requireEnumField(item, 'type', `${path}.type`, RELATION_TYPES, diagnostics);
    const state = requireEnumField(item, 'state', `${path}.state`, STATES, diagnostics);
    const status = requireEnumField(item, 'status', `${path}.status`, STATUSES, diagnostics);
    requireEnumField(item, 'confidence', `${path}.confidence`, CONFIDENCES, diagnostics);
    const evidenceRefs = validateEvidenceIds(item, path, evidenceIds, diagnostics);

    const sourceResolved = hasSource && nodeIndex.ids.has(item.source);
    const targetResolved = hasTarget && nodeIndex.ids.has(item.target);
    if (hasSource && !sourceResolved) {
      push(diagnostics, CODES.DANGLING_EDGE_ENDPOINT, `${path}.source`, `Edge source "${item.source}" does not match any declared node id.`);
    }
    if (hasTarget && !targetResolved) {
      push(diagnostics, CODES.DANGLING_EDGE_ENDPOINT, `${path}.target`, `Edge target "${item.target}" does not match any declared node id.`);
    }

    if (typeof state === 'string' && sourceResolved && targetResolved) {
      const sourceState = nodeIndex.stateById.get(item.source);
      const targetState = nodeIndex.stateById.get(item.target);
      if (typeof sourceState === 'string' && typeof targetState === 'string' && (sourceState !== state || targetState !== state)) {
        push(diagnostics, CODES.EDGE_STATE_MISMATCH, `${path}.state`,
          `Edge state "${state}" must match both endpoints: source "${item.source}" is "${sourceState}", target "${item.target}" is "${targetState}".`);
      }
    }

    if (status === 'confirmed' && evidenceRefs !== null && countResolvedEvidence(evidenceRefs, evidenceIds) === 0) {
      push(diagnostics, CODES.UNPROVEN_CONFIRMED_FACT, `${path}.evidenceIds`,
        `Edge "${item.id}" is confirmed but references no declared evidence; confirmed facts require at least one evidence entry.`);
    }
  });
}

function validateRuntimeEvidence(collections, diagnostics) {
  const runtimeIds = new Set(collections.evidence
    .filter(item => isPlainObject(item) && item.type === 'runtime')
    .map(item => item.id));
  for (const name of ['nodes', 'edges']) {
    collections[name].forEach((item, index) => {
      if (!isPlainObject(item) || item.state !== 'runtime' || item.status !== 'confirmed') return;
      if (!Array.isArray(item.evidenceIds) || item.evidenceIds.some(id => runtimeIds.has(id))) return;
      push(diagnostics, CODES.UNPROVEN_CONFIRMED_FACT, `${name}[${index}].evidenceIds`,
        'Confirmed runtime observations require runtime evidence; static evidence alone is insufficient.');
    });
  }
}

function validateHierarchy(nodes, nodeIds, diagnostics) {
  const parentById = new Map();
  const indexById = new Map();

  nodes.forEach((node, index) => {
    if (!isPlainObject(node) || !isNonEmptyString(node.id)) return;
    if (!indexById.has(node.id)) indexById.set(node.id, index);
    if (!hasOwn(node, 'parentId') || !isNonEmptyString(node.parentId)) return;
    const path = `nodes[${index}].parentId`;
    if (!nodeIds.has(node.parentId)) {
      push(diagnostics, CODES.UNKNOWN_PARENT_NODE, path, `Parent node "${node.parentId}" is not declared in "nodes".`);
      return;
    }
    if (!parentById.has(node.id)) parentById.set(node.id, node.parentId);
  });

  detectHierarchyCycles(nodes, parentById, indexById, diagnostics);
}

// Each node has at most one parent, so cycles are found by walking parent links.
// A cycle is reported once, at the first cycle member, and the whole traversed
// chain is marked resolved to keep the diagnostic list stable.
function detectHierarchyCycles(nodes, parentById, indexById, diagnostics) {
  const resolved = new Set();

  nodes.forEach((node) => {
    if (!isPlainObject(node) || !isNonEmptyString(node.id) || resolved.has(node.id)) return;

    const chain = [];
    const positionInChain = new Map();
    let current = node.id;
    while (current !== undefined && !resolved.has(current)) {
      if (positionInChain.has(current)) {
        const cycle = chain.slice(positionInChain.get(current));
        const startIndex = indexById.get(cycle[0]);
        push(diagnostics, CODES.HIERARCHY_CYCLE, `nodes[${startIndex}].parentId`,
          `Hierarchy cycle detected: ${[...cycle, cycle[0]].join(' -> ')}.`);
        break;
      }
      positionInChain.set(current, chain.length);
      chain.push(current);
      current = parentById.get(current);
    }
    for (const id of chain) resolved.add(id);
  });
}

module.exports = {
  validateModel,
  SUPPORTED_SCHEMA_VERSION,
  ENUMS: { NODE_TYPES, RELATION_TYPES, STATES, STATUSES, CONFIDENCES, EVIDENCE_TYPES },
  COLLECTIONS: { ID_COLLECTIONS, GENERIC_ID_COLLECTIONS },
};
