'use strict';

const { validateModel } = require('./validation');
const { CODES } = require('./error-codes');
const { compareStrings } = require('./compare-strings');

// Deterministic layered layout. Geometry is fixed so the same model always
// yields a byte-identical string; a header band sits above layer 0.
const BOX_W = 168;
const BOX_H = 46;
const GAP_X = 44;
const GAP_Y = 72;
const MARGIN = 32;
const HEADER_BAND = 44;

const DEFAULT_MAX_NODES = 120;
const DEFAULT_MAX_EDGES = 240;
const MAX_BUDGET = 2000;
const MAX_FOCUS_LENGTH = 1024;
// A valid model cannot contain a parentId cycle, but the depth walk is bounded
// so a hostile or corrupt model can never spin here.
const MAX_DEPTH_WALK = 32;

// error-codes.js declares no INVALID_MODEL key; export-preview.js uses this
// literal for the same refusal, so the code stays consistent across the plugin.
const INVALID_MODEL_CODE = 'invalid_model';

const BASE_LIMITATION = "Deterministic layered layout derived from each node's parentId chain; it is not a measured runtime topology and no source file was read to build it.";

const XML_ESCAPES = Object.freeze({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&apos;', '"': '&quot;' });

// Interaction and palette live in one inline <style> so hover/emphasis work with
// zero JavaScript. Colours reuse the export-preview palette.
const STYLE = [
  '.dg-node { cursor: pointer; }',
  '.dg-node:hover rect { stroke: #7fd8ff; }',
  '.dg-edge { stroke: #3d5468; fill: none; }',
  '[data-emphasis="off"] { opacity: 0.22; }',
  '.dg-name { fill: #e6edf5; font: 600 13px sans-serif; }',
  '.dg-meta { fill: #91a0b3; font: 10px monospace; }',
].join('');

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBudget(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_BUDGET;
}

function escapeXml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => XML_ESCAPES[char]);
}

function invalidOption(field, message) {
  return { code: CODES.INVALID_OPTION, message: `Invalid option "${field}": ${message}` };
}

function failure(error) {
  return { ok: false, error: { code: error.code, message: error.message }, limitations: [BASE_LIMITATION] };
}

// Depth is the number of parentId hops to a root. A missing, non-string or
// undeclared parent is a root (depth 0); a chain longer than the cap or a cycle
// is treated as depth 0 rather than throwing or looping.
function depthOf(nodeId, byId) {
  let depth = 0;
  let current = byId.get(nodeId);
  const seen = new Set([nodeId]);
  while (current) {
    const parentId = current.parentId;
    if (typeof parentId !== 'string' || !byId.has(parentId)) break;
    if (seen.has(parentId)) return 0;
    seen.add(parentId);
    depth += 1;
    if (depth > MAX_DEPTH_WALK) return 0;
    current = byId.get(parentId);
  }
  return depth;
}

function buildAdjacency(model) {
  const adjacency = new Map(model.nodes.map((node) => [node.id, new Set()]));
  for (const edge of model.edges) {
    if (adjacency.has(edge.source)) adjacency.get(edge.source).add(edge.target);
    if (adjacency.has(edge.target)) adjacency.get(edge.target).add(edge.source);
  }
  return adjacency;
}

// One barycenter pass: order each layer by the mean index its previous-layer
// neighbours already occupy. A node with no previous-layer neighbour keeps its
// position (its own index), and id is the tiebreaker so the order is total.
function refineLayer(layerIds, prevLayer, adjacency) {
  const prevIndex = new Map(prevLayer.map((id, index) => [id, index]));
  const decorated = layerIds.map((id, ownIndex) => {
    let sum = 0;
    let count = 0;
    for (const neighbour of adjacency.get(id) || []) {
      if (prevIndex.has(neighbour)) {
        sum += prevIndex.get(neighbour);
        count += 1;
      }
    }
    return { id, bary: count > 0 ? sum / count : ownIndex };
  });
  decorated.sort((left, right) => (left.bary - right.bary) || compareStrings(left.id, right.id));
  return decorated.map((entry) => entry.id);
}

function centerOf(id, indexById, depthById) {
  const index = indexById.get(id);
  const depth = depthById.get(id);
  return {
    x: MARGIN + index * (BOX_W + GAP_X) + BOX_W / 2,
    y: MARGIN + HEADER_BAND + depth * (BOX_H + GAP_Y) + BOX_H / 2,
  };
}

function renderSvg(context) {
  const { width, height, renderedNodeIds, renderedEdges, indexById, depthById, byId, onNodes, focus } = context;

  const edges = renderedEdges.map((edge) => {
    const from = centerOf(edge.source, indexById, depthById);
    const to = centerOf(edge.target, indexById, depthById);
    const emphasis = focus === null || edge.source === focus || edge.target === focus ? 'on' : 'off';
    return `<path class="dg-edge" data-source="${escapeXml(edge.source)}" data-target="${escapeXml(edge.target)}" data-emphasis="${emphasis}" d="M ${from.x} ${from.y} L ${to.x} ${to.y}" marker-end="url(#dg-arrow)"/>`;
  }).join('');

  const nodes = renderedNodeIds.map((id) => {
    const node = byId.get(id);
    const depth = depthById.get(id);
    const x = MARGIN + indexById.get(id) * (BOX_W + GAP_X);
    const y = MARGIN + HEADER_BAND + depth * (BOX_H + GAP_Y);
    const emphasis = onNodes.has(id) ? 'on' : 'off';
    const meta = `${node.id} · ${node.type} · ${node.status}`;
    return `<g class="dg-node" data-node-id="${escapeXml(node.id)}" data-depth="${depth}" data-emphasis="${emphasis}">`
      + `<rect x="${x}" y="${y}" width="${BOX_W}" height="${BOX_H}" rx="6" fill="#102938" stroke="#55c8e8"/>`
      + `<title>${escapeXml(meta)}</title>`
      + `<text class="dg-name" x="${x + 12}" y="${y + 20}">${escapeXml(node.name)}</text>`
      + `<text class="dg-meta" x="${x + 12}" y="${y + 36}">${escapeXml(meta)}</text>`
      + '</g>';
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Architecture relationship diagram">`
    + `<style>${STYLE}</style>`
    + '<rect width="100%" height="100%" fill="#0b111b"/>'
    + '<defs><marker id="dg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#3d5468"/></marker></defs>'
    + edges
    + nodes
    + '</svg>';
}

function readOptions(model, options) {
  const source = isPlainObject(options) ? options : {};

  let maxNodes = DEFAULT_MAX_NODES;
  if (source.maxNodes !== undefined) {
    if (!isBudget(source.maxNodes)) return { error: invalidOption('maxNodes', `an integer in 1..${MAX_BUDGET} is required.`) };
    maxNodes = source.maxNodes;
  }
  let maxEdges = DEFAULT_MAX_EDGES;
  if (source.maxEdges !== undefined) {
    if (!isBudget(source.maxEdges)) return { error: invalidOption('maxEdges', `an integer in 1..${MAX_BUDGET} is required.`) };
    maxEdges = source.maxEdges;
  }

  let focus = null;
  if (source.focus !== undefined) {
    if (typeof source.focus !== 'string' || source.focus === '' || source.focus.length > MAX_FOCUS_LENGTH) {
      return { error: invalidOption('focus', `a declared node id string of at most ${MAX_FOCUS_LENGTH} characters is required.`) };
    }
    if (!model.nodes.some((node) => node.id === source.focus)) {
      return { error: invalidOption('focus', `"${source.focus}" is not the id of a declared node.`) };
    }
    focus = source.focus;
  }

  return { value: { maxNodes, maxEdges, focus } };
}

function renderDiagram(model, settings) {
  const byId = new Map(model.nodes.map((node) => [node.id, node]));
  const depthById = new Map(model.nodes.map((node) => [node.id, depthOf(node.id, byId)]));

  let maxDepth = 0;
  for (const depth of depthById.values()) if (depth > maxDepth) maxDepth = depth;
  const layerCount = maxDepth + 1;

  const layers = [];
  for (let depth = 0; depth < layerCount; depth += 1) layers.push([]);
  for (const node of model.nodes) layers[depthById.get(node.id)].push(node.id);
  for (const layer of layers) layer.sort((left, right) => compareStrings(left, right));

  const adjacency = buildAdjacency(model);
  for (let depth = 1; depth < layerCount; depth += 1) {
    layers[depth] = refineLayer(layers[depth], layers[depth - 1], adjacency);
  }

  let widestLayer = 0;
  for (const layer of layers) if (layer.length > widestLayer) widestLayer = layer.length;
  const width = MARGIN * 2 + widestLayer * (BOX_W + GAP_X) - GAP_X;
  const height = MARGIN + HEADER_BAND + (layerCount - 1) * (BOX_H + GAP_Y) + BOX_H + MARGIN;

  const renderOrder = [];
  for (const layer of layers) for (const id of layer) renderOrder.push(id);
  const renderedNodeIds = renderOrder.slice(0, settings.maxNodes);
  const renderedNodeSet = new Set(renderedNodeIds);
  const omittedNodes = model.nodes.length - renderedNodeIds.length;

  const indexById = new Map();
  for (const layer of layers) layer.forEach((id, index) => indexById.set(id, index));

  const drawableEdges = model.edges.filter((edge) => renderedNodeSet.has(edge.source) && renderedNodeSet.has(edge.target));
  const renderedEdges = drawableEdges.slice(0, settings.maxEdges);
  const omittedEdges = model.edges.length - renderedEdges.length;
  const truncated = omittedNodes > 0 || omittedEdges > 0;

  let focus = null;
  let onNodes = renderedNodeSet;
  if (settings.focus !== null) {
    const neighbours = Array.from(adjacency.get(settings.focus) || []).sort(compareStrings);
    focus = { id: settings.focus, name: byId.get(settings.focus).name, neighbours };
    onNodes = new Set([settings.focus, ...neighbours]);
  }

  const svg = renderSvg({ width, height, renderedNodeIds, renderedEdges, indexById, depthById, byId, onNodes, focus: settings.focus });
  const nodes = renderedNodeIds.map((id) => {
    const node = byId.get(id);
    return { id: node.id, name: node.name, type: node.type, status: node.status, depth: depthById.get(id) };
  });
  const edges = renderedEdges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, type: edge.type }));

  const limitations = [BASE_LIMITATION];
  if (truncated) {
    limitations.push(`Truncated to the node/edge budget: ${omittedNodes} node(s) and ${omittedEdges} edge(s) were omitted. The diagram is incomplete, not small.`);
  }

  return {
    ok: true,
    svg,
    nodes,
    edges,
    focus,
    truncated,
    omitted: { nodes: omittedNodes, edges: omittedEdges },
    layout: { layers: layerCount, width, height, maxNodes: settings.maxNodes, maxEdges: settings.maxEdges },
    limitations,
  };
}

/**
 * Renders a self-contained interactive SVG relationship diagram from a v1 model.
 *
 * Pure and deterministic: no fs, network, clock or randomness, inputs are never
 * mutated, and it never throws. The layout is layered by parentId, not measured.
 *
 * @param {object} model A v1 architecture model validated by validateModel.
 * @param {{focus?: string, maxNodes?: number, maxEdges?: number}} [options]
 * @returns {{ok: true, svg: string, nodes: object[], edges: object[], focus: object|null, truncated: boolean, omitted: {nodes: number, edges: number}, layout: object, limitations: string[]}|{ok: false, error: {code: string, message: string}, limitations: string[]}}
 */
function buildDiagram(model, options) {
  try {
    const validation = validateModel(model);
    if (!validation.valid) {
      return {
        ok: false,
        error: { code: INVALID_MODEL_CODE, message: 'Diagram rendering requires a valid v1 architecture model.' },
        validation,
        limitations: [BASE_LIMITATION],
      };
    }
    const settings = readOptions(model, options);
    if (settings.error !== undefined) return failure(settings.error);
    return renderDiagram(model, settings.value);
  } catch {
    return failure({ code: CODES.INTERNAL_ERROR, message: 'Diagram rendering failed unexpectedly; no diagram was produced.' });
  }
}

module.exports = { buildDiagram };
