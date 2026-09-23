'use strict';

const { createGraph, edgesOutOf, edgesInto, otherEnd } = require('./graph');
const { compareStrings } = require('./compare-strings');

const { CODES } = require('./error-codes');
const { ENUMS } = require('./validation');

// Deterministic breadth-first traversal; seeds do not consume the node budget.
const DIRECTIONS = Object.freeze(['downstream', 'upstream', 'both']);
const KNOWN_RELATION_SET = new Set(ENUMS.RELATION_TYPES);

const DEFAULT_DIRECTION = 'downstream';
const DEFAULT_IMPACT_DEPTH = 5;
const DEFAULT_MAX_NODES = 500;
const DEFAULT_MAX_TIME_MS = 1000;

const REASON = Object.freeze({
  MAX_DEPTH: 'max_depth',
  MAX_NODES: 'max_nodes',
  MAX_TIME_BUDGET: 'max_time_budget',
  CYCLE_DETECTED: 'cycle_detected',
  UNKNOWN_RELATION_TYPE: 'unknown_relation_type',
  UNKNOWN_ENDPOINT: 'unknown_endpoint',
  FRONTIER_EXHAUSTED: 'frontier_exhausted',
});

const ERROR_CODE = { ...CODES, INVALID_MODEL: CODES.UNSUPPORTED_INPUT };

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Message helpers never serialize a value: a cyclic model must not be able to
// turn a diagnostic into a throw.
function describe(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `the string ${JSON.stringify(value)}`;
  if (typeof value === 'object') return 'an object';
  return String(value);
}

function describeToken(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  return `a value of type ${typeof value}`;
}

function emptyStats() {
  return { visitedNodes: 0, visitedEdges: 0, maxDepthReached: 0, elapsedMs: 0 };
}

function errorResult(error) {
  return {
    ok: false,
    error: { code: error.code, message: error.message },
    targets: [],
    unresolvedTargets: [],
    impacted: [],
    stopReasons: [],
    truncated: false,
    dangling: [],
    stats: emptyStats(),
  };
}

function invalidOption(field, message) {
  return { code: ERROR_CODE.INVALID_OPTION, message: `Invalid option "${field}": ${message}` };
}

function invalidModel(field, message) {
  return { code: ERROR_CODE.INVALID_MODEL, message: `Invalid "${field}": ${message}` };
}

function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

// Total order for untrusted id arrays. Values that are not strings stay in their
// original relative order instead of being coerced, so a malformed model can
// neither throw nor change the order of the values it declared.
function compareIdValues(left, right) {
  const leftIsString = typeof left === 'string';
  const rightIsString = typeof right === 'string';
  if (leftIsString && rightIsString) return compareStrings(left, right);
  if (leftIsString) return -1;
  if (rightIsString) return 1;
  return 0;
}

function sortedCopy(value) {
  const list = Array.isArray(value) ? value.slice() : [];
  list.sort(compareIdValues);
  return list;
}

// A `now` that returns a non-finite value cannot be measured; treating it as the
// epoch keeps a broken injection from fabricating or hiding a budget stop.
function readNow(now) {
  const value = now();
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

// Mirrors the adjacency ordering of the graph index so that merging the two
// directions stays independent of which list an edge came from.
function compareEdges(left, right) {
  return compareStrings(left.type, right.type)
    || compareStrings(left.source, right.source)
    || compareStrings(left.target, right.target)
    || compareStrings(left.id, right.id);
}

function edgesFor(graph, nodeId, direction) {
  if (direction === 'downstream') return edgesOutOf(graph, nodeId);
  if (direction === 'upstream') return edgesInto(graph, nodeId);
  const merged = [];
  const seen = new Set();
  for (const edge of edgesOutOf(graph, nodeId)) {
    seen.add(edge);
    merged.push(edge);
  }
  for (const edge of edgesInto(graph, nodeId)) {
    if (seen.has(edge)) continue;
    seen.add(edge);
    merged.push(edge);
  }
  merged.sort(compareEdges);
  return merged;
}

function followsRelation(type, relationTypes) {
  if (relationTypes === null) return true;
  return relationTypes.has(type);
}

function normalizeImpactOptions(options) {
  if (!hasOwn(options, 'targets') || options.targets === undefined) {
    if (options.changeSource !== undefined || options.branch !== undefined) {
      return { error: { code: CODES.CHANGE_SOURCE_UNAVAILABLE, message: 'Explicit targets are required; branch and changeSource cannot be resolved without an injected change provider.' } };
    }
    return { error: invalidOption('targets', 'a non-empty array of node ids or file paths is required; received undefined.') };
  }
  const rawTargets = options.targets;
  if (!Array.isArray(rawTargets) || rawTargets.length === 0) {
    return { error: invalidOption('targets', `a non-empty array of node ids or file paths is required; received ${describe(rawTargets)}.`) };
  }
  for (let index = 0; index < rawTargets.length; index += 1) {
    if (typeof rawTargets[index] !== 'string') {
      return { error: invalidOption('targets', `element ${index} must be a string; received ${describe(rawTargets[index])}.`) };
    }
  }

  let direction = DEFAULT_DIRECTION;
  if (hasOwn(options, 'direction') && options.direction !== undefined) {
    if (!DIRECTIONS.includes(options.direction)) {
      return { error: invalidOption('direction', `one of ${DIRECTIONS.join(', ')} is required; received ${describe(options.direction)}.`) };
    }
    direction = options.direction;
  }

  let relationTypes = null;
  if (hasOwn(options, 'relationTypes') && options.relationTypes !== undefined) {
    if (!Array.isArray(options.relationTypes)) {
      return { error: invalidOption('relationTypes', `an array of relation type strings is required; received ${describe(options.relationTypes)}.`) };
    }
    for (let index = 0; index < options.relationTypes.length; index += 1) {
      if (typeof options.relationTypes[index] !== 'string') {
        return { error: invalidOption('relationTypes', `element ${index} must be a string; received ${describe(options.relationTypes[index])}.`) };
      }
    }
    relationTypes = new Set(options.relationTypes);
  }

  let maxDepth = DEFAULT_IMPACT_DEPTH;
  if (hasOwn(options, 'maxDepth') && options.maxDepth !== undefined) {
    if (!isPositiveInteger(options.maxDepth)) {
      return { error: invalidOption('maxDepth', `an integer >= 1 is required; received ${describe(options.maxDepth)}.`) };
    }
    maxDepth = options.maxDepth;
  }

  let maxNodes = DEFAULT_MAX_NODES;
  if (hasOwn(options, 'maxNodes') && options.maxNodes !== undefined) {
    if (!isPositiveInteger(options.maxNodes)) {
      return { error: invalidOption('maxNodes', `an integer >= 1 is required; received ${describe(options.maxNodes)}.`) };
    }
    maxNodes = options.maxNodes;
  }

  let maxTimeMs = DEFAULT_MAX_TIME_MS;
  if (hasOwn(options, 'maxTimeMs') && options.maxTimeMs !== undefined) {
    if (!isPositiveNumber(options.maxTimeMs)) {
      return { error: invalidOption('maxTimeMs', `a number > 0 is required; received ${describe(options.maxTimeMs)}.`) };
    }
    maxTimeMs = options.maxTimeMs;
  }

  // Real-time safety budgets are opt-in through an injected clock.
  let now = () => 0;
  if (hasOwn(options, 'now') && options.now !== undefined) {
    if (typeof options.now !== 'function') {
      return { error: invalidOption('now', `a function returning milliseconds is required; received ${describe(options.now)}.`) };
    }
    now = options.now;
  }

  return {
    value: {
      targetInputs: Array.from(new Set(rawTargets)).sort(compareStrings),
      direction,
      relationTypes,
      maxDepth,
      maxNodes,
      maxTimeMs,
      now,
    },
  };
}

function isUsableGraph(value) {
  return isPlainObject(value)
    && value.nodeById instanceof Map
    && value.outgoing instanceof Map
    && value.incoming instanceof Map
    && Array.isArray(value.nodes)
    && Array.isArray(value.edges);
}

function resolveGraph(options) {
  if (hasOwn(options, 'graph') && options.graph !== undefined && options.graph !== null) {
    if (!isUsableGraph(options.graph)) {
      return { error: invalidModel('graph', 'a graph index built by createGraph(model) is required.') };
    }
    return { value: options.graph };
  }
  if (hasOwn(options, 'model') && options.model !== undefined && options.model !== null) {
    if (!isPlainObject(options.model)) {
      return { error: invalidModel('model', `a v1 model object is required; received ${describe(options.model)}.`) };
    }
    return { value: createGraph(options.model) };
  }
  return { value: createGraph({}) };
}

// File targets resolve only through stable file IDs or declared evidence paths.
function resolveTargets(graph, inputs) {
  const targets = [];
  const unresolvedTargets = [];
  const byPath = new Map();
  const addReferences = (record, nodeIds) => {
    for (const evidenceId of Array.isArray(record.evidenceIds) ? record.evidenceIds : []) {
      const evidence = graph.evidenceById.get(evidenceId);
      if (!evidence || typeof evidence.path !== 'string') continue;
      if (!byPath.has(evidence.path)) byPath.set(evidence.path, new Set());
      for (const id of nodeIds) if (graph.nodeById.has(id)) byPath.get(evidence.path).add(id);
    }
  };
  for (const node of graph.nodes) addReferences(node, [node.id]);
  for (const edge of graph.edges) addReferences(edge, [edge.source, edge.target]);
  for (const input of inputs) {
    const matched = new Set(byPath.get(input) || []);
    if (graph.nodeById.has(input)) matched.add(input);
    if (graph.nodeById.has(`file:${input}`)) matched.add(`file:${input}`);
    const matchedNodeIds = Array.from(matched).sort(compareStrings);
    if (matchedNodeIds.length === 0) {
      unresolvedTargets.push({ input, reason: 'No stable node ID, stable file ID or declared evidence path matches this target.' });
    } else {
      targets.push({ input, matchedNodeIds });
    }
  }
  return { targets, unresolvedTargets };
}

function makeImpactEntry(graph, nodeId, depth, via) {
  const node = graph.nodeById.get(nodeId);
  const record = node !== null && typeof node === 'object' ? node : {};
  return {
    nodeId,
    depth,
    via: { edgeId: via.edgeId, fromNodeId: via.fromNodeId, type: via.type },
    status: record.status,
    confidence: record.confidence,
    evidenceIds: sortedCopy(record.evidenceIds),
  };
}

// Edges a frontier node would actually expand at the depth limit, counted the
// same way the main loop filters them: kept by relationTypes, a known relation
// type, and a far end that is a declared node.
function countExpandableEdges(graph, frontier, settings) {
  let count = 0;
  let firstNodeId = null;
  for (const nodeId of frontier) {
    let nodeCount = 0;
    for (const edge of edgesFor(graph, nodeId, settings.direction)) {
      if (!followsRelation(edge.type, settings.relationTypes)) continue;
      if (!KNOWN_RELATION_SET.has(edge.type)) continue;
      if (!graph.nodeById.has(otherEnd(edge, nodeId))) continue;
      nodeCount += 1;
    }
    if (nodeCount > 0 && firstNodeId === null) firstNodeId = nodeId;
    count += nodeCount;
  }
  return { count, firstNodeId };
}

function traverse(graph, seeds, settings) {
  const startedAt = readNow(settings.now);
  const reached = new Map();
  for (const seed of seeds) reached.set(seed, 0);

  const impacted = [];
  const traversed = new Map();
  const usedEdges = new Set();
  function closesCycle(from, to) {
    const pending = [to];
    const seen = new Set();
    while (pending.length) {
      const current = pending.pop();
      if (current === from) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const next of traversed.get(current) || []) pending.push(next);
    }
    return false;
  }
  const stopReasons = [];
  let visitedNodes = 0;
  let visitedEdges = 0;
  let maxDepthReached = 0;
  let truncated = false;
  let frontier = seeds.slice();
  let depth = 1;

  while (frontier.length > 0 && depth <= settings.maxDepth) {
    const arrivals = new Map();
    let budgetStopped = false;

    for (const nodeId of frontier) {
      const elapsedMs = readNow(settings.now) - startedAt;
      if (elapsedMs >= settings.maxTimeMs) {
        stopReasons.push({
          reason: REASON.MAX_TIME_BUDGET,
          nodeId,
          detail: `the ${settings.maxTimeMs}ms time budget was reached before expanding "${nodeId}"; the remaining frontier was not expanded`,
        });
        truncated = true;
        budgetStopped = true;
        break;
      }
      visitedNodes += 1;

      for (const edge of edgesFor(graph, nodeId, settings.direction)) {
        if (readNow(settings.now) - startedAt >= settings.maxTimeMs) {
          stopReasons.push({ reason: REASON.MAX_TIME_BUDGET, nodeId, detail: 'Time budget reached before traversing the next edge.' });
          truncated = true;
          budgetStopped = true;
          break;
        }
        if (!followsRelation(edge.type, settings.relationTypes)) continue;
        visitedEdges += 1;

        if (!KNOWN_RELATION_SET.has(edge.type)) {
          stopReasons.push({
            reason: REASON.UNKNOWN_RELATION_TYPE,
            nodeId,
            detail: `edge "${edge.id}" has relation type ${describeToken(edge.type)}, which is outside the v1 relation types; the edge was not traversed`,
          });
          continue;
        }

        const other = otherEnd(edge, nodeId);
        // The index also lists an edge whose far end is undeclared, so that the
        // dangling reference stays visible; such an edge can never reach a node.
        if (!graph.nodeById.has(other)) {
          stopReasons.push({ reason: REASON.UNKNOWN_ENDPOINT, nodeId, detail: `edge "${edge.id}" points to undeclared endpoint ${describeToken(other)}; the edge was not traversed` });
          continue;
        }
        if (settings.direction === 'both' && usedEdges.has(edge)) continue;
        usedEdges.add(edge);
        // In both mode preserve relation orientation; reversing a shared edge
        // must not manufacture a cycle in an otherwise acyclic model.
        const from = settings.direction === 'both' ? edge.source : nodeId;
        const to = settings.direction === 'both' ? edge.target : other;
        const cycle = closesCycle(from, to);
        if (!traversed.has(from)) traversed.set(from, new Set());
        traversed.get(from).add(to);
        if (cycle) {
          stopReasons.push({
            reason: REASON.CYCLE_DETECTED,
            nodeId,
            detail: `edge "${edge.id}" (${edge.type}) closes a directed path between already reached endpoints "${from}" and "${to}"`,
          });
          continue;
        }
        if (reached.has(other)) continue;

        const known = arrivals.get(other);
        if (known === undefined || compareStrings(edge.id, known.edgeId) < 0) {
          arrivals.set(other, { edgeId: edge.id, fromNodeId: nodeId, type: edge.type });
        }
      }
      if (budgetStopped) break;
    }

    if (budgetStopped) break;

    const ordered = Array.from(arrivals.keys()).sort(compareStrings);
    const capacity = settings.maxNodes - impacted.length;
    let accepted = ordered;
    if (ordered.length > capacity) {
      accepted = ordered.slice(0, capacity);
      truncated = true;
      stopReasons.push({
        reason: REASON.MAX_NODES,
        nodeId: ordered[capacity],
        detail: `maxNodes=${settings.maxNodes} was reached; ${ordered.length - capacity} node(s) reaching depth ${depth} were not expanded`,
      });
    }

    const nextFrontier = [];
    for (const nodeId of accepted) {
      if (readNow(settings.now) - startedAt >= settings.maxTimeMs) {
        stopReasons.push({ reason: REASON.MAX_TIME_BUDGET, nodeId, detail: 'Time budget reached before accepting the next node.' });
        truncated = true;
        break;
      }
      impacted.push(makeImpactEntry(graph, nodeId, depth, arrivals.get(nodeId)));
      reached.set(nodeId, depth);
      nextFrontier.push(nodeId);
      maxDepthReached = depth;
    }
    frontier = nextFrontier;
    if (truncated) break;
    depth += 1;
  }

  if (!truncated && frontier.length > 0) {
    const skipped = countExpandableEdges(graph, frontier, settings);
    if (skipped.count > 0) {
      stopReasons.push({
        reason: REASON.MAX_DEPTH,
        nodeId: skipped.firstNodeId,
        detail: `maxDepth=${settings.maxDepth} was reached; ${skipped.count} edge(s) out of the deepest frontier were not expanded`,
      });
      truncated = true;
    }
  }

  if (!truncated && stopReasons.length === 0) {
    stopReasons.push({
      reason: REASON.FRONTIER_EXHAUSTED,
      detail: 'traversal completed: no frontier nodes remained within the configured budgets',
    });
  }

  const nodeIdOf = (entry) => (entry.nodeId === undefined ? '' : entry.nodeId);
  stopReasons.sort((left, right) =>
    compareStrings(left.reason, right.reason)
    || compareStrings(nodeIdOf(left), nodeIdOf(right))
    || compareStrings(left.detail, right.detail));

  return {
    impacted,
    stopReasons,
    truncated,
    visitedNodes,
    visitedEdges,
    maxDepthReached,
    elapsedMs: readNow(settings.now) - startedAt,
  };
}

function run(input) {
  const options = isPlainObject(input) ? input : {};

  const normalized = normalizeImpactOptions(options);
  if (normalized.error !== undefined) return errorResult(normalized.error);

  const resolved = resolveGraph(options);
  if (resolved.error !== undefined) return errorResult(resolved.error);
  const graph = resolved.value;
  const settings = normalized.value;

  const { targets, unresolvedTargets } = resolveTargets(graph, settings.targetInputs);
  const seedSet = new Set();
  for (const target of targets) {
    for (const nodeId of target.matchedNodeIds) seedSet.add(nodeId);
  }
  const seeds = Array.from(seedSet).sort(compareStrings);

  const traversal = traverse(graph, seeds, settings);

  return {
    ok: true,
    targets,
    unresolvedTargets,
    impacted: traversal.impacted,
    stopReasons: traversal.stopReasons,
    truncated: traversal.truncated,
    dangling: Array.isArray(graph.dangling) ? graph.dangling.slice() : [],
    stats: {
      visitedNodes: traversal.visitedNodes,
      visitedEdges: traversal.visitedEdges,
      maxDepthReached: traversal.maxDepthReached,
      elapsedMs: traversal.elapsedMs,
    },
  };
}

/**
 * Computes which nodes are affected by one or more seed nodes.
 *
 * Never throws; diagnostics use shared CODES and retain exception messages.
 *
 * @param {{model?: object, graph?: object, targets?: string[], direction?: string, relationTypes?: string[], maxDepth?: number, maxNodes?: number, maxTimeMs?: number, now?: () => number}} [input]
 * @returns {{ok: boolean, error?: {code: string, message: string}, targets: Array<{input: string, matchedNodeIds: string[]}>, unresolvedTargets: Array<{input: string, reason: string}>, impacted: Array<{nodeId: string, depth: number, via: {edgeId: string, fromNodeId: string, type: string}, status: unknown, confidence: unknown, evidenceIds: unknown[]}>, stopReasons: Array<{reason: string, nodeId?: string, detail: string}>, truncated: boolean, dangling: Array<object>, stats: {visitedNodes: number, visitedEdges: number, maxDepthReached: number, elapsedMs: number}}}
 */
function computeImpact(input) {
  try {
    return run(input);
  } catch (error) {
    return errorResult({ code: CODES.INTERNAL_ERROR, message: 'Impact analysis failed unexpectedly; no result was computed.' });
  }
}

module.exports = { computeImpact };
