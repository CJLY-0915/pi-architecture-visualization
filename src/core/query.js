'use strict';

const { createGraph, edgesOutOf, edgesInto, compareStrings, EMPTY } = require('./graph');
const { ENUMS } = require('./validation');
const { CODES } = require('./error-codes');

// Relation types outside this set are reported as an unknown relation rather
// than followed, so a query can never silently walk a shape the model schema
// does not define.
const RELATION_TYPES = ENUMS.RELATION_TYPES;
const NODE_TYPES = ENUMS.NODE_TYPES;

const DIRECTIONS = Object.freeze(['upstream', 'downstream', 'both']);

// Deterministic queries over a v1 architecture model.
//
// Every query is a pure function of (model, parameters): traversal is bounded by
// maxDepth, maxNodes and a time budget, and all output arrays are sorted, so the
// same model and parameters always produce the same result regardless of the
// input array order.
//
// The three stop kinds are deliberately distinguishable, because "we found
// nothing" and "we stopped looking" are different claims:
//   - cycle:      a loop exists; it is a shape, not a defect, and is returned
//                 with its full membership and the edges that close it
//   - depth/node/time budget: the search was cut short (truncated)
//   - frontier_exhausted: the neighbourhood is genuinely complete
//
// Dangling references are surfaced rather than dropped: a model that did not
// pass validation must not silently appear smaller than it is.

const CONFIDENCE_RANK = Object.freeze({ high: 3, medium: 2, low: 1, unknown: 0 });

// Filter fields describe different collections: ids and types only exist on
// nodes, relation types only exist on edges. Applying one to the wrong
// collection would silently empty it.
const NODE_FILTER_FIELDS = Object.freeze(['ids', 'types']);
const EDGE_FILTER_FIELDS = Object.freeze(['relationTypes']);
const SHARED_FILTER_FIELDS = Object.freeze(['statuses', 'confidences', 'evidenceTypes']);


const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_NODES = 500;
const DEFAULT_MAX_TIME_MS = 1000;
const DEFAULT_MAX_STEPS = 10000;
const MAX_LIMIT = 100000;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function optionError(path, message) {
  return { code: CODES.INVALID_OPTION, path, message };
}

function internalError() {
  return { ok: false, error: { code: CODES.INTERNAL_ERROR, path: '', message: 'The query failed unexpectedly; the model was not interpreted.' } };
}

class InvalidClockError extends Error {}

function checkedClock(clock = () => 0) {
  return () => {
    if (typeof clock !== 'function') throw new InvalidClockError();
    const value = clock();
    if (!Number.isFinite(value)) throw new InvalidClockError();
    return value;
  };
}

function queryFailure(error) {
  return error instanceof InvalidClockError
    ? emptyResult(optionError('options.now', '"now" must return a finite number.'))
    : internalError();
}

function unknownNodeError(path, nodeId) {
  return { code: CODES.UNKNOWN_NODE, path, message: `Node "${nodeId}" is not declared in the model.` };
}


function readLimit(options, name, fallback, errors) {
  const value = options[name];
  if (value === undefined || value === null) return fallback;
  if (!isPositiveInteger(value) || value > MAX_LIMIT) {
    errors.push(optionError(`options.${name}`, `"options.${name}" must be a positive integer of at most ${MAX_LIMIT}.`));
    return fallback;
  }
  return value;
}

/**
 * Normalizes query options, collecting every rejected field instead of stopping
 * at the first one so a caller sees all of its mistakes at once.
 *
 * @returns {{ok: boolean, errors: Array<{path: string, message: string}>, limits: object, filters: object}}
 */
function normalizeOptions(rawOptions) {
  const options = isPlainObject(rawOptions) ? rawOptions : {};
  const errors = [];

  const limits = {
    maxDepth: readLimit(options, 'maxDepth', DEFAULT_MAX_DEPTH, errors),
    maxNodes: readLimit(options, 'maxNodes', DEFAULT_MAX_NODES, errors),
    maxSteps: readLimit(options, 'maxSteps', DEFAULT_MAX_STEPS, errors),
    maxTimeMs: readLimit(options, 'maxTimeMs', DEFAULT_MAX_TIME_MS, errors),
  };

  if (!isPlainObject(rawOptions) && rawOptions !== undefined && rawOptions !== null) {
    errors.push({ path: 'options', message: 'Query options must be an object.' });
  }
  if (options.now !== undefined && typeof options.now !== 'function') {
    errors.push(optionError('options.now', '"now" must be a function.'));
  }

  const nodeFilters = {};
  const edgeFilters = {};
  const sharedFilters = {};
  // Node ids and node types only describe nodes, and relation types only
  // describe edges: applying either to the other collection would silently
  // empty it.
  for (const field of NODE_FILTER_FIELDS) {
    const value = options[field];
    if (value === undefined || value === null) continue;
    if (!isEnumArray(value, field === 'types' ? NODE_TYPES : undefined)) {
      errors.push({ path: `options.${field}`, message: `"options.${field}" must be an array of non-empty strings.` });
      continue;
    }
    nodeFilters[field] = Array.from(new Set(value)).sort(compareStrings);
  }

  for (const field of EDGE_FILTER_FIELDS) {
    const value = options[field];
    if (value === undefined || value === null) continue;
    if (!isEnumArray(value, RELATION_TYPES)) {
      errors.push({ path: `options.${field}`, message: `"options.${field}" must be an array of non-empty strings.` });
      continue;
    }
    edgeFilters[field] = Array.from(new Set(value)).sort(compareStrings);
  }

  for (const field of SHARED_FILTER_FIELDS) {
    const value = options[field];
    if (value === undefined || value === null) continue;
    if (!isEnumArray(value, undefined)) {
      errors.push({ path: `options.${field}`, message: `"options.${field}" must be an array of non-empty strings.` });
      continue;
    }
    sharedFilters[field] = Array.from(new Set(value)).sort(compareStrings);
  }

  for (const field of ['minConfidence', 'evidencePath']) {
    const value = options[field];
    if (value === undefined || value === null) continue;
    if (field === 'minConfidence') {
      if (!Object.prototype.hasOwnProperty.call(CONFIDENCE_RANK, value)) {
        errors.push({ path: 'options.minConfidence', message: '"options.minConfidence" must be high, medium, low or unknown.' });
        continue;
      }
    } else if (typeof value !== 'string' || value === '') {
      errors.push({ path: 'options.evidencePath', message: '"options.evidencePath" must be a non-empty string.' });
      continue;
    }
    sharedFilters[field] = value;
  }

  return { ok: errors.length === 0, errors: errors.map((error) => ({ code: CODES.INVALID_OPTION, ...error })), limits, filters: { node: nodeFilters, edge: edgeFilters, shared: sharedFilters } };
}

function isEnumArray(value, allowed) {
  if (!Array.isArray(value) || value.length === 0) return false;
  for (const entry of value) {
    if (typeof entry !== 'string' || entry === '') return false;
    if (allowed !== undefined && !allowed.includes(entry)) return false;
  }
  return true;
}


function matchesNodeFilters(node, filters) {
  if (filters.node.ids !== undefined && !filters.node.ids.includes(node.id)) return false;
  if (filters.node.types !== undefined && !filters.node.types.includes(node.type)) return false;
  return matchesSharedFilters(node, filters);
}

function matchesEdgeFilters(edge, filters) {
  if (filters.edge.relationTypes !== undefined && !filters.edge.relationTypes.includes(edge.type)) return false;
  return matchesSharedFilters(edge, filters);
}

function matchesSharedFilters(value, filters) {
  const shared = filters.shared;
  if (shared.statuses !== undefined && !shared.statuses.includes(value.status)) return false;
  if (shared.confidences !== undefined && !shared.confidences.includes(value.confidence)) return false;
  if (shared.minConfidence !== undefined) {
    const actual = CONFIDENCE_RANK[value.confidence];
    if (actual === undefined || actual < CONFIDENCE_RANK[shared.minConfidence]) return false;
  }
  if (shared.evidenceTypes !== undefined) {
    const evidence = Array.isArray(value.evidence) ? value.evidence : [];
    if (!evidence.some((entry) => shared.evidenceTypes.includes(entry.type))) return false;
  }
  if (shared.evidencePath !== undefined) {
    const evidence = Array.isArray(value.evidence) ? value.evidence : [];
    if (!evidence.some((entry) => entry.path === shared.evidencePath)) return false;
  }
  return true;
}

// Resolves evidenceIds to declared evidence entries, keeping the declared order
// and reporting ids that do not resolve instead of dropping them.
function expandEvidence(node, graph) {
  const ids = Array.isArray(node.evidenceIds) ? node.evidenceIds : [];
  const evidence = [];
  const missing = [];
  for (const id of ids) {
    const entry = graph.evidenceById.get(id);
    if (entry === undefined) missing.push(id);
    else evidence.push(entry);
  }
  return { evidence, missingEvidenceIds: missing, evidenceIds: ids.slice() };
}

function summarizeNode(node, graph) {
  const resolved = expandEvidence(node, graph);
  return {
    id: node.id,
    name: typeof node.name === 'string' ? node.name : node.id,
    type: node.type,
    status: node.status,
    confidence: node.confidence,
    evidenceIds: resolved.evidenceIds,
    evidence: resolved.evidence,
    missingEvidenceIds: resolved.missingEvidenceIds,
  };
}

function summarizeEdge(edge, graph) {
  const resolved = expandEvidence(edge, graph);
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: edge.type,
    status: edge.status,
    confidence: edge.confidence,
    evidenceIds: resolved.evidenceIds,
    evidence: resolved.evidence,
    missingEvidenceIds: resolved.missingEvidenceIds,
  };
}

function compareByDepthThenId(left, right) {
  return left.depth - right.depth || compareStrings(left.nodeId, right.nodeId);
}

function compareStops(left, right) {
  return compareStrings(left.reason, right.reason)
    || compareStrings(left.nodeId || '', right.nodeId || '')
    || compareStrings(left.detail || '', right.detail || '');
}

// Bounded breadth-first traversal. Returns the visited nodes with the depth and
// edge through which each was first reached, plus every reason the walk stopped.
function traverse(graph, seeds, options = {}) {
  try {
    return traverseBounded(graph, seeds, options);
  } catch (error) {
    return queryFailure(error);
  }
}

function traverseBounded(graph, seeds, options) {
  const errors = [];
  const maxSteps = readLimit(options, 'maxSteps', DEFAULT_MAX_STEPS, errors);
  if (errors.length) return emptyResult(errors[0]);
  const now = checkedClock(options.now);
  const { direction = 'downstream', relationTypes, maxDepth = DEFAULT_MAX_DEPTH,
    maxNodes = DEFAULT_MAX_NODES, maxTimeMs = DEFAULT_MAX_TIME_MS } = options;
  const visited = new Map();
  const seedIds = new Set(seeds);
  const stops = [];
  const startedAt = now();
  let visitedEdges = 0;
  let maxDepthReached = 0;
  let truncated = false;
  const frontier = [];
  for (const nodeId of Array.from(seedIds).sort(compareStrings)) {
    if (now() - startedAt > maxTimeMs) {
      stops.push({ reason: 'max_time_budget', nodeId, detail: 'The traversal time budget was exceeded.' });
      truncated = true;
      frontier.length = 0;
      break;
    }
    if (!graph.nodeById.has(nodeId)) {
      stops.push({ reason: 'unsupported_input', nodeId, detail: 'The seed is not declared in the model.' });
      continue;
    }
    frontier.push({ nodeId, depth: 0, trail: [nodeId], edgeIds: [] });
  }
  search: for (let cursor = 0; cursor < frontier.length; cursor += 1) {
    if (now() - startedAt > maxTimeMs) {
      stops.push({ reason: 'max_time_budget', nodeId: '', detail: 'The traversal time budget was exceeded.' });
      truncated = true;
      break;
    }
    const entry = frontier[cursor];
    for (const step of pendingEdges(graph, entry.nodeId, direction, relationTypes)) {
      if (now() - startedAt > maxTimeMs) {
        stops.push({ reason: 'max_time_budget', nodeId: entry.nodeId, detail: 'The traversal time budget was exceeded.' });
        truncated = true;
        break search;
      }
      if (visitedEdges >= maxSteps) {
        stops.push({ reason: 'max_steps', nodeId: entry.nodeId, detail: `maxSteps (${maxSteps}) was reached.` });
        truncated = true;
        break search;
      }
      visitedEdges += 1;
      const childId = step.edge.source === entry.nodeId ? step.edge.target : step.edge.source;
      if (!canFollow(graph, step, childId, stops)) continue;
      if (entry.edgeIds.includes(step.edge.id)) continue;
      if (entry.trail.includes(childId)) {
        stops.push({ reason: 'cycle_detected', nodeId: childId, detail: `Edge "${step.edge.id}" closes the current path.` });
        continue;
      }
      if (seedIds.has(childId) || visited.has(childId)) continue;
      if (entry.depth >= maxDepth) {
        stops.push({ reason: 'max_depth', nodeId: entry.nodeId, detail: `maxDepth (${maxDepth}) prevents following edge "${step.edge.id}".` });
        truncated = true;
        continue;
      }
      // Seeds are origins, not impacted nodes; check immediately before admission.
      if (visited.size >= maxNodes) {
        stops.push({ reason: 'max_nodes', nodeId: childId, detail: `maxNodes (${maxNodes}) prevents admitting this node.` });
        truncated = true;
        break search;
      }
      const depth = entry.depth + 1;
      visited.set(childId, { nodeId: childId, depth,
        via: { edgeId: step.edge.id, fromNodeId: entry.nodeId, type: step.edge.type } });
      maxDepthReached = Math.max(maxDepthReached, depth);
      frontier.push({ nodeId: childId, depth, trail: entry.trail.concat(childId), edgeIds: entry.edgeIds.concat(step.edge.id) });
    }
  }
  if (!truncated) stops.push({ reason: 'frontier_exhausted', nodeId: '', detail: 'Every reachable node within the given bounds was visited.' });
  const impacted = Array.from(visited.values()).sort(compareByDepthThenId);
  stops.sort(compareStops);
  return { impacted, stops, truncated,
    stats: { visitedNodes: impacted.length, visitedEdges, steps: visitedEdges, maxDepthReached, elapsedMs: now() - startedAt } };
}

function canFollow(graph, step, childId, stops) {
  if (step.unknownType) {
    stops.push({ reason: 'unknown_relation_type', nodeId: childId, detail: `Edge "${step.edge.id}" has unknown relation type "${step.edge.type}" and was not followed.` });
    return false;
  }
  if (!graph.nodeById.has(childId)) {
    stops.push({ reason: 'unsupported_input', nodeId: childId, detail: `Edge "${step.edge.id}" resolves to an undeclared node and was not followed.` });
    return false;
  }
  return true;
}

// Collects the edges to follow, tagging any edge whose relation type is outside
// the v1 set so the caller can report it instead of silently following it.
function pendingEdges(graph, nodeId, direction, relationTypes) {
  const selected = [];
  if (direction === 'downstream' || direction === 'both') {
    for (const edge of edgesOutOf(graph, nodeId)) selected.push(edge);
  }
  if (direction === 'upstream' || direction === 'both') {
    for (const edge of edgesInto(graph, nodeId)) selected.push(edge);
  }
  const steps = [];
  const seen = new Set();
  for (const edge of selected) {
    if (seen.has(edge.id)) continue;
    seen.add(edge.id);
    if (relationTypes !== undefined && !relationTypes.includes(edge.type)) continue;
    steps.push({ edge, unknownType: !RELATION_TYPES.includes(edge.type) });
  }
  steps.sort((left, right) => compareStrings(left.edge.id, right.edge.id));
  return steps;
}

function resolveGraph(input) {
  if (isPlainObject(input) && input.graph !== undefined && input.graph !== null) {
    const graph = input.graph;
    if (!isPlainObject(graph) || !(graph.nodeById instanceof Map)) return null;
    return graph;
  }
  return createGraph(isPlainObject(input) ? input.model : undefined);
}

/**
 * Filters model nodes and edges by stable id, type, status, confidence and evidence.
 *
 * @param {{model?: object, graph?: object, node?: object, edge?: object, limit?: number}} input
 * @returns {{ok: boolean, error?: object, nodes: Array<object>, edges: Array<object>, totalNodes: number, totalEdges: number, truncated: boolean, dangling: Array<object>}}
 */
function queryModel(input) {
  try {
    const request = isPlainObject(input) ? input : {};
    const normalized = normalizeOptions(request);
    if (!normalized.ok) {
      return { ok: false, error: { code: CODES.INVALID_OPTION, path: normalized.errors[0].path, message: normalized.errors[0].message }, diagnostics: normalized.errors, nodes: [], edges: [], totalNodes: 0, totalEdges: 0, truncated: false, dangling: [] };
    }
    const graph = resolveGraph(request);
    if (graph === null) {
      return { ok: false, error: { code: CODES.INVALID_OPTION, path: 'graph', message: 'A provided graph must be a graph index; omit it to build one from the model.' }, nodes: [], edges: [], totalNodes: 0, totalEdges: 0, truncated: false, dangling: [] };
    }

    const limit = request.limit === undefined ? graph.nodes.length : request.limit;
    if (!isPositiveInteger(limit) && request.limit !== undefined && request.limit !== 0) {
      return { ok: false, error: { code: CODES.INVALID_OPTION, path: 'limit', message: '"limit" must be a non-negative integer.' }, nodes: [], edges: [], totalNodes: 0, totalEdges: 0, truncated: false, dangling: [] };
    }

    const matchedNodes = graph.nodes
      .map((node) => summarizeNode(node, graph))
      .filter((node) => matchesNodeFilters(node, normalized.filters));
    const matchedIds = new Set(matchedNodes.map((node) => node.id));
    const matchedEdges = graph.edges
      .map((edge) => summarizeEdge(edge, graph))
      .filter((edge) => matchesEdgeFilters(edge, normalized.filters))
      .filter((edge) => (request.edgeEndpointsResolved !== false
        ? matchedIds.has(edge.source) && matchedIds.has(edge.target)
        : true));

    const truncated = matchedNodes.length > limit || matchedEdges.length > limit;
    return {
      ok: true,
      nodes: truncated ? matchedNodes.slice(0, limit) : matchedNodes,
      edges: truncated ? matchedEdges.slice(0, limit) : matchedEdges,
      totalNodes: matchedNodes.length,
      totalEdges: matchedEdges.length,
      truncated,
      dangling: graph.dangling.map((entry) => ({ id: entry.id, reason: entry.reason, nodeId: entry.nodeId })),
    };
  } catch {
    return internalError();
  }
}

/**
 * Reports the immediate neighbours of a set of nodes.
 *
 * @param {{model?: object, graph?: object, targets?: string[], direction?: string, relationTypes?: string[]}} input
 * @returns {{ok: boolean, error?: object, neighbours: Array<object>, stops: Array<object>, dangling: Array<object>, stats: object}}
 */
function queryNeighbours(input) {
  try {
    const request = isPlainObject(input) ? input : {};
    const seeds = readTargets(request);
    if (seeds.error !== undefined) return emptyResult(seeds.error);
    const direction = request.direction === undefined ? 'both' : request.direction;
    if (!DIRECTIONS.includes(direction)) return emptyResult(optionError('direction', '"direction" must be upstream, downstream or both.'));
    const relationTypes = readRelationTypes(request);
    if (relationTypes.error !== undefined) return emptyResult(relationTypes.error);
    const normalized = normalizeOptions(request);
    if (!normalized.ok) return emptyResult(normalized.errors[0]);

    const graph = resolveGraph(request);
    if (graph === null) return emptyResult(optionError('graph', 'A provided graph must be a graph index; omit it to build one from the model.'));
    for (const nodeId of seeds.ids) {
      if (!graph.nodeById.has(nodeId)) return emptyResult(unknownNodeError('targets', nodeId));
    }
    const { maxNodes, maxTimeMs, maxSteps } = normalized.limits;
    const now = checkedClock(request.now);
    const startedAt = now();
    let truncated = false;
    let visitedEdges = 0;

    const neighbours = [];
    const stops = [];
    search: for (const nodeId of seeds.ids) {
      if (now() - startedAt > maxTimeMs) {
        stops.push({ reason: 'max_time_budget', nodeId, detail: 'The neighbour time budget was exceeded.' });
        truncated = true;
        break;
      }
      for (const step of pendingEdges(graph, nodeId, direction, relationTypes.values)) {
        if (now() - startedAt > maxTimeMs) {
          stops.push({ reason: 'max_time_budget', nodeId, detail: 'The neighbour time budget was exceeded.' });
          truncated = true;
          break search;
        }
        if (visitedEdges >= maxSteps) {
          stops.push({ reason: 'max_steps', nodeId, detail: `maxSteps (${maxSteps}) was reached.` });
          truncated = true;
          break search;
        }
        visitedEdges += 1;
        const edge = step.edge;
        const otherId = edge.source === nodeId ? edge.target : edge.source;
        if (step.unknownType) {
          stops.push({ reason: 'unknown_relation_type', nodeId: otherId, detail: `Edge "${edge.id}" has relation type "${edge.type}", which is outside the v1 relation set; it was not reported as a neighbour.` });
          continue;
        }
        const node = graph.nodeById.get(otherId);
        if (node === undefined) {
          stops.push({ reason: 'unsupported_input', nodeId: otherId, detail: `Edge "${edge.id}" resolves to an undeclared node and was not reported as a neighbour.` });
          continue;
        }
        if (neighbours.length >= maxNodes) {
          stops.push({ reason: 'max_nodes', nodeId: otherId, detail: `maxNodes (${maxNodes}) prevents admitting this neighbour.` });
          truncated = true;
          break search;
        }
        neighbours.push(Object.assign(summarizeNode(node, graph), {
          direction: edge.source === nodeId ? 'outgoing' : 'incoming',
          via: summarizeEdge(edge, graph),
        }));
      }
    }
    neighbours.sort((left, right) => compareStrings(left.direction, right.direction)
      || compareStrings(left.via.type, right.via.type)
      || compareStrings(left.id, right.id));
    stops.sort(compareStops);

    return {
      ok: true,
      neighbours,
      stops,
      truncated,
      dangling: graph.dangling.map((entry) => ({ id: entry.id, reason: entry.reason, nodeId: entry.nodeId })),
      stats: { visitedNodes: neighbours.length, visitedEdges, steps: visitedEdges, maxDepthReached: neighbours.length ? 1 : 0, elapsedMs: now() - startedAt },
    };
  } catch (error) {
    return queryFailure(error);
  }
}

function emptyResult(error) {
  return { ok: false, error, neighbours: [], nodes: [], impacted: [], stops: [], dangling: [], stats: { visitedNodes: 0, visitedEdges: 0, maxDepthReached: 0, elapsedMs: 0 } };
}

function readTargets(request) {
  const targets = request.targets;
  if (!Array.isArray(targets) || targets.length === 0) {
    return { error: optionError('targets', '"targets" must be a non-empty array of node ids.') };
  }
  if (targets.some((entry) => typeof entry !== 'string' || entry === '')) {
    return { error: optionError('targets', '"targets" entries must be non-empty strings.') };
  }
  return { ids: Array.from(new Set(targets)).sort(compareStrings) };
}

function readRelationTypes(request) {
  const value = request.relationTypes;
  if (value === undefined || value === null) return { values: undefined };
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry === '')) {
    return { error: optionError('relationTypes', '"relationTypes" must be an array of non-empty strings.') };
  }
  return { values: Array.from(new Set(value)).sort(compareStrings) };
}

/**
 * Finds simple paths between two nodes, bounded in depth, node count and time.
 *
 * @param {{model?: object, graph?: object, from?: string, to?: string, direction?: string, relationTypes?: string[], maxDepth?: number, maxNodes?: number, maxTimeMs?: number, now?: Function}} input
 * @returns {{ok: boolean, error?: object, paths: Array<Array<object>>, stops: Array<object>, truncated: boolean, dangling: Array<object>, stats: object}}
 */
function queryPaths(input) {
  try {
    const request = isPlainObject(input) ? input : {};
    if (typeof request.from !== 'string' || request.from === '') return emptyResult(optionError('from', '"from" must be a non-empty node id.'));
    if (typeof request.to !== 'string' || request.to === '') return emptyResult(optionError('to', '"to" must be a non-empty node id.'));
    const direction = request.direction === undefined ? 'downstream' : request.direction;
    if (!DIRECTIONS.includes(direction)) return emptyResult(optionError('direction', '"direction" must be upstream, downstream or both.'));
    const normalized = normalizeOptions(request);
    if (!normalized.ok) {
      return emptyResult({ code: CODES.INVALID_OPTION, path: normalized.errors[0].path, message: normalized.errors[0].message });
    }
    const relationTypes = readRelationTypes(request);
    if (relationTypes.error !== undefined) return emptyResult(relationTypes.error);

    const graph = resolveGraph(request);
    if (graph === null) return emptyResult(optionError('graph', 'A provided graph must be a graph index; omit it to build one from the model.'));
    if (!graph.nodeById.has(request.from)) return emptyResult(unknownNodeError('from', request.from));
    if (!graph.nodeById.has(request.to)) return emptyResult(unknownNodeError('to', request.to));

    const { maxDepth, maxNodes, maxTimeMs, maxSteps } = normalized.limits;
    const now = checkedClock(request.now);
    const startedAt = now();
    const paths = [];
    const stops = [];
    let truncated = false;
    let visitedNodes = 0;
    let visitedEdges = 0;
    let maxDepthReached = 0;
    let explored = 0;
    let admitted = 1;

    // Depth-first with an explicit stack, so a deep graph cannot overflow the
    // call stack and every step can be time-checked before it is taken.
    const stack = [{ nodeId: request.from, trail: [{ nodeId: request.from, via: null }], onPath: new Set([request.from]) }];
    while (stack.length > 0) {
      if (now() - startedAt > maxTimeMs) {
        stops.push({ reason: 'max_time_budget', nodeId: '', detail: `The ${maxTimeMs} ms budget was exceeded; the search stopped early.` });
        truncated = true;
        break;
      }
      if (visitedNodes >= maxNodes) {
        stops.push({ reason: 'max_nodes', nodeId: '', detail: `maxNodes (${maxNodes}) was reached; the search stopped early.` });
        truncated = true;
        break;
      }
      const current = stack.pop();
      visitedNodes += 1;
      explored += 1;
      const depth = current.trail.length - 1;
      maxDepthReached = Math.max(maxDepthReached, depth);

      if (current.nodeId === request.to && depth > 0) {
        paths.push(current.trail.slice());
        continue;
      }
      // Inspect boundary edges too, so invalid references remain visible.

      const steps = pendingEdges(graph, current.nodeId, direction, relationTypes.values);
      for (let index = steps.length - 1; index >= 0; index -= 1) {
        if (now() - startedAt > maxTimeMs) {
          stops.push({ reason: 'max_time_budget', nodeId: current.nodeId, detail: 'The path time budget was exceeded.' });
          truncated = true;
          stack.length = 0;
          break;
        }
        if (visitedEdges >= maxSteps) {
          stops.push({ reason: 'max_steps', nodeId: current.nodeId, detail: `maxSteps (${maxSteps}) was reached.` });
          truncated = true;
          stack.length = 0;
          break;
        }
        visitedEdges += 1;
        const edge = steps[index].edge;
        const childId = edge.source === current.nodeId ? edge.target : edge.source;
        if (!canFollow(graph, steps[index], childId, stops)) continue;
        if (current.trail.some((entry) => entry.via && entry.via.edgeId === edge.id)) continue;
        if (current.onPath.has(childId)) {
          stops.push({ reason: 'cycle_detected', nodeId: childId, detail: `Edge "${edge.id}" closes a loop; the path was not extended.` });
          continue;
        }
        if (depth >= maxDepth) {
          stops.push({ reason: 'max_depth', nodeId: current.nodeId, detail: `maxDepth (${maxDepth}) prevents extending this path.` });
          truncated = true;
          continue;
        }
        // Bound all admitted candidates, not just states already popped.
        if (admitted >= maxNodes) {
          if (!stops.some((stop) => stop.reason === 'max_nodes')) {
            stops.push({ reason: 'max_nodes', nodeId: childId, detail: `maxNodes (${maxNodes}) prevents admitting another path candidate.` });
          }
          truncated = true;
          continue;
        }
        admitted += 1;
        const onPath = new Set(current.onPath);
        onPath.add(childId);
        stack.push({
          nodeId: childId,
          trail: current.trail.concat([{ nodeId: childId, via: { edgeId: edge.id, fromNodeId: current.nodeId, type: edge.type } }]),
          onPath,
        });
      }
    }

    paths.sort((left, right) => left.length - right.length || compareStrings(JSON.stringify(left), JSON.stringify(right)));
    if (!truncated) {
      stops.push({ reason: 'frontier_exhausted', nodeId: '', detail: 'Every simple path within the given bounds was examined.' });
    }
    stops.sort(compareStops);

    return {
      ok: true,
      paths: paths.map((trail) => trail.map((step) => (step.via === null
        ? { nodeId: step.nodeId, via: null }
        : { nodeId: step.nodeId, via: step.via }))),
      stops,
      truncated,
      dangling: graph.dangling.map((entry) => ({ id: entry.id, reason: entry.reason, nodeId: entry.nodeId })),
      stats: { visitedNodes: explored, visitedEdges, steps: visitedEdges, maxDepthReached, elapsedMs: now() - startedAt },
    };
  } catch (error) {
    return queryFailure(error);
  }
}

/**
 * Detects cycles and returns each loop in full, with the edges that close it.
 *
 * A cycle is reported as a shape, not as a defect: `isDefect` is never set here
 * and the code does not rank cycles by severity. Detecting that a loop exists is
 * a fact; deciding whether it is a problem belongs to the health stage.
 *
 * @param {{model?: object, graph?: object, direction?: string, relationTypes?: string[], maxCycles?: number, maxNodes?: number, maxTimeMs?: number, now?: Function}} input
 * @returns {{ok: boolean, error?: object, cycles: Array<object>, stops: Array<object>, truncated: boolean, dangling: Array<object>, stats: object}}
 */
function queryCycles(input) {
  try {
    const request = isPlainObject(input) ? input : {};
    const direction = request.direction === undefined ? 'downstream' : request.direction;
    if (!DIRECTIONS.includes(direction)) return emptyResult(optionError('direction', '"direction" must be upstream, downstream or both.'));
    const normalized = normalizeOptions(request);
    if (!normalized.ok) {
      return emptyResult({ code: CODES.INVALID_OPTION, path: normalized.errors[0].path, message: normalized.errors[0].message });
    }
    const relationTypes = readRelationTypes(request);
    if (relationTypes.error !== undefined) return emptyResult(relationTypes.error);
    const cycleErrors = [];
    const maxCycles = readLimit(request, 'maxCycles', 100, cycleErrors);
    if (cycleErrors.length) return emptyResult(cycleErrors[0]);

    const graph = resolveGraph(request);
    if (graph === null) return emptyResult(optionError('graph', 'A provided graph must be a graph index; omit it to build one from the model.'));

    const { maxDepth, maxNodes, maxTimeMs, maxSteps } = normalized.limits;
    const now = checkedClock(request.now);
    const startedAt = now();
    const cycles = [];
    const stops = [];
    const seen = new Set();
    const admitted = new Set();
    let truncated = false;
    let visitedEdges = 0;
    let maxDepthReached = 0;
    const stop = (reason, nodeId, detail) => {
      if (!stops.some((entry) => entry.reason === reason && entry.nodeId === nodeId)) stops.push({ reason, nodeId, detail });
      truncated = true;
    };
    const admit = (nodeId) => {
      if (admitted.has(nodeId)) return true;
      if (admitted.size >= maxNodes) {
        stop('max_nodes', nodeId, `maxNodes (${maxNodes}) prevents admitting this node.`);
        return false;
      }
      admitted.add(nodeId);
      return true;
    };

    // Enumerate simple loops from their least node. Cursor frames keep the
    // pending stack bounded by maxDepth + 1; no SCC is mistaken for a single loop.
    search: for (const root of graph.nodes) {
      if (now() - startedAt > maxTimeMs) {
        stop('max_time_budget', '', 'The cycle time budget was exceeded.');
        break;
      }
      if (!admit(root.id)) break;
      const nodeIds = [root.id];
      const pathEdges = [];
      const onPath = new Set(nodeIds);
      const work = [{ nodeId: root.id, steps: pendingEdges(graph, root.id, direction, relationTypes.values), cursor: 0 }];
      while (work.length) {
        if (now() - startedAt > maxTimeMs) {
          stop('max_time_budget', '', 'The cycle time budget was exceeded.');
          break search;
        }
        const frame = work[work.length - 1];
        if (frame.cursor === frame.steps.length) {
          work.pop();
          onPath.delete(nodeIds.pop());
          if (pathEdges.length) pathEdges.pop();
          continue;
        }
        if (visitedEdges >= maxSteps) {
          stop('max_steps', frame.nodeId, `maxSteps (${maxSteps}) was reached.`);
          break search;
        }
        const step = frame.steps[frame.cursor++];
        const edge = step.edge;
        visitedEdges += 1;
        const childId = edge.source === frame.nodeId ? edge.target : edge.source;
        if (!canFollow(graph, step, childId, stops)) continue;
        if (pathEdges.some((entry) => entry.id === edge.id)) continue;
        if (compareStrings(childId, root.id) < 0) continue;
        if (childId === root.id) {
          const edges = pathEdges.concat(edge);
          if (edges.length > maxDepth) {
            stop('max_depth', frame.nodeId, `maxDepth (${maxDepth}) prevents closing this loop.`);
            continue;
          }
          const forward = JSON.stringify([nodeIds, edges.map((entry) => entry.id)]);
          const reverse = JSON.stringify([[root.id, ...nodeIds.slice(1).reverse()], edges.map((entry) => entry.id).reverse()]);
          const signature = direction === 'both' && compareStrings(reverse, forward) < 0 ? reverse : forward;
          if (seen.has(signature)) continue;
          if (cycles.length >= maxCycles) {
            stop('max_cycles', root.id, `maxCycles (${maxCycles}) prevents reporting another loop.`);
            break search;
          }
          seen.add(signature);
          maxDepthReached = Math.max(maxDepthReached, edges.length);
          cycles.push({
            id: `cycle:${root.id}:${encodeURIComponent(signature)}`,
            nodeIds: nodeIds.slice(),
            nodes: nodeIds.map((id) => summarizeNode(graph.nodeById.get(id), graph)),
            edges: edges.map((entry) => summarizeEdge(entry, graph)),
            isDefect: null,
            note: 'A cycle is a structural shape here, not a defect; whether it is a problem is a health-stage question.',
          });
          continue;
        }
        if (onPath.has(childId)) continue;
        // Inspect nodes at the boundary before claiming their frontier is cut.
        if (pathEdges.length + 1 > maxDepth) {
          stop('max_depth', frame.nodeId, `maxDepth (${maxDepth}) prevents extending this loop candidate.`);
          continue;
        }
        if (!admit(childId)) break search;
        nodeIds.push(childId);
        pathEdges.push(edge);
        onPath.add(childId);
        maxDepthReached = Math.max(maxDepthReached, pathEdges.length);
        work.push({ nodeId: childId, steps: pendingEdges(graph, childId, direction, relationTypes.values), cursor: 0 });
      }
    }
    cycles.sort((left, right) => compareStrings(JSON.stringify(left.nodeIds), JSON.stringify(right.nodeIds))
      || compareStrings(left.id, right.id));
    if (!truncated) stops.push({ reason: 'frontier_exhausted', nodeId: '', detail: 'Every simple loop within the given bounds was examined.' });
    stops.sort(compareStops);

    return {
      ok: true,
      cycles,
      stops,
      truncated,
      dangling: graph.dangling.map((entry) => ({ id: entry.id, reason: entry.reason, nodeId: entry.nodeId })),
      stats: { visitedNodes: admitted.size, visitedEdges, steps: visitedEdges, maxDepthReached, elapsedMs: now() - startedAt },
    };
  } catch (error) {
    return queryFailure(error);
  }
}

module.exports = {
  queryModel,
  queryNeighbours,
  queryPaths,
  queryCycles,
  normalizeOptions,
  createGraph,
  traverse,
  pendingEdges,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_NODES,
  DEFAULT_MAX_TIME_MS,
  DEFAULT_MAX_STEPS,
  EMPTY,
};
