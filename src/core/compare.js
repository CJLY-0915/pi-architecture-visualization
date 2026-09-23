'use strict';

const { compareStrings } = require('./compare-strings');
const { CODES } = require('./error-codes');

// Deterministic comparison between two architecture models (for example a
// stored snapshot and a freshly collected model).
//
// The comparison never guesses identity from display text:
//   - nodes, edges and evidence are matched by their stable id only
//   - a rename is reported from an unchanged stable id (basis "stable_id"), or
//     as a candidate when exactly one removed and one added node share both
//     type and evidence paths (basis "evidence"); candidates are marked as
//     such and never presented as facts
//   - evidence that disappeared is reported as removed, and every remaining
//     fact that still references it is listed in danglingEvidenceRefs instead
//     of being silently repaired
//
// Collection order is immaterial; ordered payload arrays retain their meaning.

const NODE_FIELDS = Object.freeze(['name', 'type', 'state', 'status', 'confidence', 'parentId', 'evidenceIds']);
const EDGE_FIELDS = Object.freeze(['source', 'target', 'type', 'state', 'status', 'confidence', 'evidenceIds']);
const EVIDENCE_FIELDS = Object.freeze(['path', 'type', 'line', 'fingerprint', 'contentHash', 'revision', 'stale']);
const ID_ONLY_COLLECTIONS = Object.freeze(['views', 'findings', 'decisions', 'migrationSlices', 'unknowns']);
const COLLECTIONS = Object.freeze(['nodes', 'edges', 'evidence', ...ID_ONLY_COLLECTIONS]);
const METADATA_FIELDS = Object.freeze(['project', 'schemaVersion', 'scope', 'coverage', 'sourceRevision']);

function normalize(value, path = '') {
  if (Array.isArray(value)) {
    const items = value.map((entry) => normalize(entry));
    if (path === 'evidenceIds' || path === 'scopeRoots' || path === 'scope.roots' || COLLECTIONS.includes(path)) {
      const unique = new Map(items.map((entry) => [JSON.stringify(entry), entry]));
      return [...unique.keys()].sort(compareStrings).map((key) => unique.get(key));
    }
    return items;
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort(compareStrings).map((key) => [key, normalize(value[key], path === 'scope' ? `scope.${key}` : key)]));
  }
  return value === undefined ? null : value;
}

function validateCollections(model, side) {
  for (const name of COLLECTIONS) {
    if (!Array.isArray(model[name])) return failure(CODES.UNSUPPORTED_INPUT, `${side}.${name}`, 'A declared collection array is required.');
    const ids = new Set();
    for (let i = 0; i < model[name].length; i += 1) {
      const entry = model[name][i];
      const path = `${side}.${name}[${i}]`;
      if (!isPlainObject(entry) || typeof entry.id !== 'string' || !entry.id.trim()) return failure(CODES.UNSUPPORTED_INPUT, path, 'A record with a non-empty string id is required.');
      if (ids.has(entry.id)) return failure(CODES.DUPLICATE_ID, `${path}.id`, `Duplicate id "${entry.id}".`);
      ids.add(entry.id);
    }
  }
  return null;
}

const BASIS_STABLE_ID = 'stable_id';
const BASIS_EVIDENCE = 'evidence';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failure(code, path, message) {
  return {
    ok: false,
    error: { code, path, message },
    before: null,
    after: null,
    revisionChanged: null,
    identical: null,
    nodes: { added: [], removed: [], renamed: [], changed: [], unchanged: 0 },
    edges: { added: [], removed: [], changed: [], unchanged: 0 },
    evidence: { added: [], removed: [], changed: [], unchanged: 0, stale: [], freshnessUnknown: [] },
    idCollections: [],
    metadataChanges: [],
    confidenceChanges: [],
    renameCandidates: [],
    danglingEvidenceRefs: [],
    summary: { added: 0, removed: 0, renamed: 0, changed: 0, total: 0 },
  };
}

function internalFailure(error) {
  return failure(CODES.INTERNAL_ERROR, '', `Comparison failed: ${error instanceof Error ? error.message : String(error)}`);
}

// Inputs are checked before indexing; declarations are never silently discarded.
function indexById(list) {
  const index = new Map();
  for (const entry of list) {
    index.set(entry.id, entry);
  }
  return index;
}

function sortedIds(index) {
  return Array.from(index.keys()).sort(compareStrings);
}

// evidenceIds are compared as a set: reordering the same ids is not a change of
// meaning, and reporting it as one would create noise in every comparison.
function normalizedIds(value) {
  if (!Array.isArray(value)) return [];
  const ids = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry !== '') ids.push(entry);
  }
  return Array.from(new Set(ids)).sort(compareStrings);
}

function fieldValue(record, field) {
  return normalize(record[field], field);
}

function diffFields(before, after, fields) {
  const changes = [];
  for (const field of fields || [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => key !== 'id').sort(compareStrings)) {
    const left = fieldValue(before, field);
    const right = fieldValue(after, field);
    if (JSON.stringify(left) === JSON.stringify(right)) continue;
    changes.push({ field, before: left, after: right });
  }
  return changes;
}

function describeNode(node) {
  return {
    id: node.id,
    name: typeof node.name === 'string' ? node.name : node.id,
    type: node.type === undefined ? null : node.type,
    state: node.state === undefined ? null : node.state,
    status: node.status === undefined ? null : node.status,
    confidence: node.confidence === undefined ? null : node.confidence,
    parentId: node.parentId === undefined ? null : node.parentId,
    evidenceIds: normalizedIds(node.evidenceIds),
  };
}

function describeEdge(edge) {
  return {
    id: edge.id,
    source: edge.source === undefined ? null : edge.source,
    target: edge.target === undefined ? null : edge.target,
    type: edge.type === undefined ? null : edge.type,
    state: edge.state === undefined ? null : edge.state,
    status: edge.status === undefined ? null : edge.status,
    confidence: edge.confidence === undefined ? null : edge.confidence,
    evidenceIds: normalizedIds(edge.evidenceIds),
  };
}

function describeEvidence(entry) {
  return {
    id: entry.id,
    path: entry.path === undefined ? null : entry.path,
    type: entry.type === undefined ? null : entry.type,
    line: entry.line === undefined ? null : entry.line,
  };
}

function describeModel(model) {
  const project = isPlainObject(model.project) ? model.project : {};
  const scope = isPlainObject(model.scope) ? model.scope : {};
  return {
    schemaVersion: model.schemaVersion === undefined ? null : model.schemaVersion,
    projectId: typeof project.id === 'string' ? project.id : null,
    sourceRevision: typeof model.sourceRevision === 'string' ? model.sourceRevision : null,
    generatedAt: typeof model.generatedAt === 'string' ? model.generatedAt : null,
    scopeRoots: Array.isArray(scope.roots) ? scope.roots.filter((root) => typeof root === 'string').slice().sort(compareStrings) : [],
    nodeCount: indexById(model.nodes).size,
    edgeCount: indexById(model.edges).size,
    evidenceCount: indexById(model.evidence).size,
  };
}

function compareRecords(beforeIndex, afterIndex, fields, describe) {
  const added = [];
  const removed = [];
  const changed = [];
  let unchanged = 0;

  for (const id of sortedIds(afterIndex)) {
    if (!beforeIndex.has(id)) added.push(describe(afterIndex.get(id)));
  }
  for (const id of sortedIds(beforeIndex)) {
    const before = beforeIndex.get(id);
    if (!afterIndex.has(id)) {
      removed.push(describe(before));
      continue;
    }
    const after = afterIndex.get(id);
    const changes = diffFields(before, after, fields);
    if (changes.length === 0) unchanged += 1;
    else changed.push({ id, fields: changes });
  }

  return { added, removed, changed, unchanged };
}

function compareIdOnlyCollections(before, after) {
  return ID_ONLY_COLLECTIONS.map((collection) => {
    const result = compareRecords(indexById(before[collection]), indexById(after[collection]), null, (entry) => entry.id);
    return { collection, ...result };
  });
}

function evidenceFreshness(before, after) {
  const stale = [];
  const freshnessUnknown = [];
  for (const id of sortedIds(after)) {
    const left = before.get(id);
    const right = after.get(id);
    const fields = ['fingerprint', 'contentHash', 'revision'].filter((field) => left && left[field] != null && right[field] != null);
    const changed = fields.filter((field) => JSON.stringify(normalize(left[field])) !== JSON.stringify(normalize(right[field])));
    if (right.stale === true || changed.length) stale.push({ id, reason: right.stale === true ? 'stale_marker' : 'content_changed', fields: changed });
    else if (!fields.length) freshnessUnknown.push({ id, reason: 'No comparable fingerprint, contentHash or revision was supplied.' });
  }
  return { stale, freshnessUnknown };
}

// Evidence paths make a node's basis comparable; a node with no evidence has no
// basis and is never paired with another node.
function evidenceKey(node, evidenceIndex) {
  const ids = normalizedIds(node.evidenceIds);
  if (ids.length === 0) return null;
  const paths = [];
  for (const id of ids) {
    const entry = evidenceIndex.get(id);
    if (entry !== undefined && typeof entry.path === 'string' && entry.path !== '') paths.push(entry.path);
  }
  const unique = Array.from(new Set(paths)).sort(compareStrings);
  if (unique.length === 0) return null;
  return `${typeof node.type === 'string' ? node.type : ''}\u0000${unique.join('\u0000')}`;
}

// Pairs removed with added nodes on type plus evidence paths, but only when the
// match is unique on both sides. Two candidates sharing a key are ambiguous, so
// none of them is reported: an ambiguous pair would be a guess.
function findRenameCandidates(removedNodes, addedNodes, beforeIndex, afterIndex, beforeEvidence, afterEvidence) {
  const removedKeys = new Map();
  const addedKeys = new Map();
  const removedCounts = new Map();
  const addedCounts = new Map();

  for (const node of removedNodes) {
    const key = evidenceKey(node, beforeEvidence);
    if (key === null) continue;
    removedKeys.set(node.id, key);
    removedCounts.set(key, (removedCounts.get(key) || 0) + 1);
  }
  for (const node of addedNodes) {
    const key = evidenceKey(node, afterEvidence);
    if (key === null) continue;
    addedKeys.set(node.id, key);
    addedCounts.set(key, (addedCounts.get(key) || 0) + 1);
  }

  const candidates = [];
  for (const [id, key] of removedKeys) {
    if (removedCounts.get(key) !== 1 || addedCounts.get(key) !== 1) continue;
    const match = Array.from(addedKeys.entries()).find(([, addedKey]) => addedKey === key);
    if (match === undefined) continue;
    const before = beforeIndex.get(id);
    const after = afterIndex.get(match[0]);
    candidates.push({
      fromId: id,
      toId: match[0],
      fromName: before !== undefined && typeof before.name === 'string' ? before.name : id,
      toName: after !== undefined && typeof after.name === 'string' ? after.name : match[0],
      basis: BASIS_EVIDENCE,
      candidate: true,
      note: 'The stable id changed while type and evidence paths match one-to-one; this is a candidate that needs confirmation, not an observed rename.',
    });
  }
  return candidates.sort((left, right) => compareStrings(left.fromId, right.fromId) || compareStrings(left.toId, right.toId));
}

// Facts that still reference evidence the after model no longer declares.
function findDanglingEvidenceRefs(model, evidenceIndex) {
  const dangling = [];
  for (const collection of ['nodes', 'edges']) {
    const records = Array.isArray(model[collection]) ? model[collection] : [];
    for (const record of records) {
      if (!isPlainObject(record) || typeof record.id !== 'string' || record.id === '') continue;
      for (const id of normalizedIds(record.evidenceIds)) {
        if (evidenceIndex.has(id)) continue;
        dangling.push({ kind: collection === 'nodes' ? 'node' : 'edge', id: record.id, evidenceId: id });
      }
    }
  }
  dangling.sort((left, right) => compareStrings(left.kind, right.kind)
    || compareStrings(left.id, right.id)
    || compareStrings(left.evidenceId, right.evidenceId));
  return dangling;
}

/**
 * Compares two v1 architecture models.
 *
 * @param {{before?: object, after?: object}} input Both models are required; a missing or non-object side is rejected instead of compared against nothing.
 * @returns {{ok: boolean, error?: object, before: object, after: object, revisionChanged: boolean|null, identical: boolean|null, nodes: object, edges: object, evidence: object, idCollections: Array<object>, renameCandidates: Array<object>, danglingEvidenceRefs: Array<object>, summary: object}}
 */
function compareModels(input) {
  try {
    const request = isPlainObject(input) ? input : {};
    if (!isPlainObject(request.before)) {
      return failure(CODES.INVALID_OPTION, 'before', 'A "before" model object is required; nothing was compared.');
    }
    if (!isPlainObject(request.after)) {
      return failure(CODES.INVALID_OPTION, 'after', 'An "after" model object is required; nothing was compared.');
    }

    const before = request.before;
    const after = request.after;
    for (const [side, model] of [['before', before], ['after', after]]) {
      const invalid = validateCollections(model, side);
      if (invalid) return invalid;
    }
    const beforeNodes = Array.isArray(before.nodes) ? before.nodes : [];
    const afterNodes = Array.isArray(after.nodes) ? after.nodes : [];
    const beforeIndex = indexById(beforeNodes);
    const afterIndex = indexById(afterNodes);
    const beforeEvidence = indexById(before.evidence);
    const afterEvidence = indexById(after.evidence);

    const nodes = compareRecords(beforeIndex, afterIndex, NODE_FIELDS, describeNode);
    const edges = compareRecords(indexById(before.edges), indexById(after.edges), EDGE_FIELDS, describeEdge);
    const evidence = compareRecords(beforeEvidence, afterEvidence, EVIDENCE_FIELDS, describeEvidence);
    Object.assign(evidence, evidenceFreshness(beforeEvidence, afterEvidence));

    // A rename whose stable id survived is an observed change of the name; the
    // identity claim rests on the id, which the model contract freezes.
    const renamed = [];
    for (const id of sortedIds(beforeIndex)) {
      if (!afterIndex.has(id)) continue;
      const beforeName = beforeIndex.get(id).name;
      const afterName = afterIndex.get(id).name;
      if (typeof beforeName !== 'string' || typeof afterName !== 'string') continue;
      if (beforeName === afterName) continue;
      renamed.push({ id, from: beforeName, to: afterName, basis: BASIS_STABLE_ID });
    }
    renamed.sort((left, right) => compareStrings(left.id, right.id));
    nodes.renamed = renamed;

    const renameCandidates = findRenameCandidates(
      nodes.removed.map((entry) => beforeIndex.get(entry.id)),
      nodes.added.map((entry) => afterIndex.get(entry.id)),
      beforeIndex,
      afterIndex,
      beforeEvidence,
      afterEvidence,
    );

    const beforeDescriptor = describeModel(before);
    const afterDescriptor = describeModel(after);
    const revisionChanged = beforeDescriptor.sourceRevision !== afterDescriptor.sourceRevision;
    const metadataChanges = diffFields(before, after, METADATA_FIELDS);
    const idCollections = compareIdOnlyCollections(before, after);
    const confidenceChanges = [ ['nodes', nodes], ['edges', edges], ['evidence', evidence], ...idCollections.map((entry) => [entry.collection, entry]) ]
      .flatMap(([collection, result]) => result.changed.flatMap(({ id, fields }) => fields.filter((field) => field.field === 'confidence').map((field) => ({ collection, id, before: field.before, after: field.after }))));

    const summary = {
      added: nodes.added.length + edges.added.length + evidence.added.length + idCollections.reduce((sum, entry) => sum + entry.added.length, 0),
      removed: nodes.removed.length + edges.removed.length + evidence.removed.length + idCollections.reduce((sum, entry) => sum + entry.removed.length, 0),
      renamed: renamed.length,
      changed: nodes.changed.length + edges.changed.length + evidence.changed.length + idCollections.reduce((sum, entry) => sum + entry.changed.length, 0) + metadataChanges.length,
      renameCandidates: renameCandidates.length,
      danglingEvidenceRefs: 0,
      total: 0,
    };
    const danglingEvidenceRefs = findDanglingEvidenceRefs(after, afterEvidence);
    summary.danglingEvidenceRefs = danglingEvidenceRefs.length;
    // Renames are already represented by node field changes.
    summary.total = summary.added + summary.removed + summary.changed;

    const identical = summary.total === 0
      && summary.renameCandidates === 0
      && danglingEvidenceRefs.length === 0
      && metadataChanges.length === 0
      && revisionChanged === false;

    return {
      ok: true,
      before: beforeDescriptor,
      after: afterDescriptor,
      revisionChanged,
      identical,
      nodes,
      edges,
      evidence,
      idCollections,
      metadataChanges,
      confidenceChanges,
      renameCandidates,
      danglingEvidenceRefs,
      summary,
    };
  } catch (error) {
    return internalFailure(error);
  }
}

module.exports = {
  compareModels,
  ID_ONLY_COLLECTIONS,
};
