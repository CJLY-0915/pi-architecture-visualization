'use strict';

const { compareStrings } = require('./compare-strings');

// Deterministic graph index over a v1 architecture model.
//
// The index is the single traversal foundation for every P4 query: filters,
// neighbourhoods, paths, cycles and impact all read adjacency from here, so
// ordering rules and dangling-reference handling live in exactly one place.
//
// Ordering is total and independent of input order: nodes by id, and every
// adjacency list by (type, other end, id). Two models that differ only in array
// order therefore produce identical query results.
//
// References that do not resolve are reported instead of dropped. A model that
// passed the validator never has them, but a query must stay honest on a model
// that did not, and an unreadable edge could otherwise silently shrink a
// neighbourhood.


function listOf(map, key) {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const created = [];
  map.set(key, created);
  return created;
}

function compareEdges(left, right) {
  return compareStrings(left.type, right.type)
    || compareStrings(left.source, right.source)
    || compareStrings(left.target, right.target)
    || compareStrings(left.id, right.id);
}

/**
 * Builds the adjacency index.
 *
 * @param {object} model A v1 model; missing or malformed collections are treated as empty.
 * @returns {{nodes: Array<object>, edges: Array<object>, nodeById: Map<string, object>, evidenceById: Map<string, object>, outgoing: Map<string, Array<object>>, incoming: Map<string, Array<object>>, dangling: Array<object>}}
 */
function createGraph(model) {
  const source = model !== null && typeof model === 'object' ? model : {};
  const rawNodes = Array.isArray(source.nodes) ? source.nodes : [];
  const rawEdges = Array.isArray(source.edges) ? source.edges : [];
  const rawEvidence = Array.isArray(source.evidence) ? source.evidence : [];

  const nodeById = new Map();
  const nodes = [];
  for (const node of rawNodes) {
    if (node === null || typeof node !== 'object' || typeof node.id !== 'string' || node.id === '') continue;
    if (nodeById.has(node.id)) continue;
    nodeById.set(node.id, node);
    nodes.push(node);
  }
  nodes.sort((left, right) => compareStrings(left.id, right.id));

  const evidenceById = new Map();
  for (const entry of rawEvidence) {
    if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string' || entry.id === '') continue;
    if (!evidenceById.has(entry.id)) evidenceById.set(entry.id, entry);
  }

  const outgoing = new Map();
  const incoming = new Map();
  const edges = [];
  const dangling = [];

  for (const edge of rawEdges) {
    if (edge === null || typeof edge !== 'object' || typeof edge.id !== 'string' || edge.id === '') continue;
    edges.push(edge);
    if (!nodeById.has(edge.source)) {
      dangling.push({ id: edge.id, reason: 'unknown_source', nodeId: String(edge.source) });
    }
    if (!nodeById.has(edge.target)) {
      dangling.push({ id: edge.id, reason: 'unknown_target', nodeId: String(edge.target) });
    }
    if (nodeById.has(edge.source)) listOf(outgoing, edge.source).push(edge);
    if (nodeById.has(edge.target)) listOf(incoming, edge.target).push(edge);
  }

  edges.sort((left, right) => compareStrings(left.id, right.id));
  dangling.sort((left, right) => compareStrings(left.id, right.id) || compareStrings(left.reason, right.reason));
  for (const list of outgoing.values()) list.sort(compareEdges);
  for (const list of incoming.values()) list.sort(compareEdges);

  return { nodes, edges, nodeById, evidenceById, outgoing, incoming, dangling };
}

// Sorted adjacency accessors. Returning a shared empty array keeps callers from
// having to null-check while still preventing accidental mutation of the index.
const EMPTY = Object.freeze([]);

function edgesOutOf(graph, nodeId) {
  return graph.outgoing.get(nodeId) || EMPTY;
}

function edgesInto(graph, nodeId) {
  return graph.incoming.get(nodeId) || EMPTY;
}

function otherEnd(edge, nodeId) {
  return edge.source === nodeId ? edge.target : edge.source;
}

module.exports = { createGraph, edgesOutOf, edgesInto, otherEnd, EMPTY };
