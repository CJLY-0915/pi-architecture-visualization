'use strict';

const { readModel, isSafeRelativePath } = require('./read-model');
const queries = require('../core/query');
const { computeImpact } = require('../core/impact');
const { compareModels } = require('../core/compare');
const { CODES } = require('../core/error-codes');
const manifest = require('../../manifest.json');

const ANALYSIS_TOOL_NAMES = ['architecture_query', 'architecture_impact', 'architecture_compare'];
const MAX_RESPONSE_BYTES = 240 * 1024;
const MODES = { filter: queries.queryModel, neighbours: queries.queryNeighbours, paths: queries.queryPaths, cycles: queries.queryCycles };

function fail(code, message) {
  return { ok: false, error: { code, message } };
}

// Only the small JSON Schema subset used by our manifest is needed here.
function validValue(value, schema) {
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === 'array') return Array.isArray(value)
    && (schema.maxItems === undefined || value.length <= schema.maxItems)
    && (schema.minItems === undefined || value.length >= schema.minItems)
    && value.every((item) => validValue(item, schema.items));
  if (schema.type === 'integer') return Number.isSafeInteger(value)
    && (schema.minimum === undefined || value >= schema.minimum)
    && (schema.maximum === undefined || value <= schema.maximum);
  if (schema.type === 'string') return typeof value === 'string'
    && (schema.minLength === undefined || value.length >= schema.minLength)
    && (schema.maxLength === undefined || value.length <= schema.maxLength);
  if (schema.type === 'boolean') return typeof value === 'boolean';
  return false;
}

function checkRequest(request, schema) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return false;
  if ((schema.required || []).some((key) => request[key] === undefined)) return false;
  return Object.entries(request).every(([key, value]) =>
    (key === 'branch' || key === 'changeSource') && typeof value === 'string' && value.trim() === ''
      ? true
      : Object.hasOwn(schema.properties, key) && validValue(value, schema.properties[key]));
}

function boundResponse(result) {
  const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  if (bytes <= MAX_RESPONSE_BYTES) return result;
  return {
    ...fail('RESULT_TOO_LARGE', 'Analysis output exceeds the host response budget. Narrow the query or use smaller model snapshots; no partial result is presented as complete.'),
    truncated: true,
    responseBytes: bytes,
    maxResponseBytes: MAX_RESPONSE_BYTES,
  };
}

function modelContext(model) {
  return { project: model.project, scope: model.scope, sourceRevision: model.sourceRevision, coverage: model.coverage };
}

async function execute(host, name, request, schema) {
  const hasChangeSource = request && ((typeof request.branch === 'string' && request.branch.trim() !== '')
    || (typeof request.changeSource === 'string' && request.changeSource.trim() !== ''));
  if (hasChangeSource) {
    return fail(CODES.CHANGE_SOURCE_UNAVAILABLE, 'Branch/change-set lookup is unavailable. Supply explicit model paths and impact targets; Git state is never inferred.');
  }
  if (!checkRequest(request, schema)) return fail(CODES.INVALID_OPTION, 'Arguments must match the declared tool schema, including bounded budgets and known fields.');
  if (name === 'architecture_compare' && (!request.beforePath || !request.afterPath)) {
    return fail(CODES.CHANGE_SOURCE_UNAVAILABLE, 'Both explicit model snapshot paths are required; no change source was inferred.');
  }
  if (name === 'architecture_impact' && !request.targets) {
    return fail(CODES.CHANGE_SOURCE_UNAVAILABLE, 'Explicit node IDs or evidence file paths are required; no change source was inferred.');
  }
  const paths = name === 'architecture_compare' ? [request.beforePath, request.afterPath] : [request.path];
  if (!paths.every(isSafeRelativePath)) return fail('INVALID_PATH', 'Use workspace-relative model file paths without traversal.');
  const loaded = [];
  for (const path of paths) {
    const result = await readModel(host, path);
    if (!result.ok) return result;
    loaded.push(result.model);
  }
  if (name === 'architecture_compare') {
    return { ...compareModels({ before: loaded[0], after: loaded[1] }), sourceContentVerified: false };
  }
  const { path, mode, ...parameters } = request;
  const input = { maxNodes: 500, ...parameters, model: loaded[0] };
  // Timing is explicitly requested and injected at this I/O boundary only.
  if (request.maxTimeMs !== undefined) input.now = () => Date.now();
  const result = name === 'architecture_query'
    ? MODES[mode || 'filter'](input)
    : computeImpact(input);
  return { ...result, modelContext: modelContext(loaded[0]), sourceContentVerified: false };
}

function analysisDefinition(name) {
  return manifest.contributes.agentTools.find((entry) => entry.name === name) || null;
}

async function executeAnalysis(host, name, request) {
  const definition = analysisDefinition(name);
  if (!definition || !ANALYSIS_TOOL_NAMES.includes(name)) {
    return fail(CODES.UNSUPPORTED_INPUT, 'This analysis operation is not available.');
  }
  try {
    return boundResponse(await execute(host, name, request, definition.schema));
  } catch {
    return fail(CODES.INTERNAL_ERROR, 'Analysis failed unexpectedly; no complete result was produced.');
  }
}

function createAnalysisTools(host) {
  return ANALYSIS_TOOL_NAMES.map((name) => {
    const definition = analysisDefinition(name);
    if (!definition) throw new Error(`Missing tool declaration: ${name}`);
    return { ...definition, execute: (request) => executeAnalysis(host, name, request) };
  });
}

module.exports = { createAnalysisTools, executeAnalysis, ANALYSIS_TOOL_NAMES, boundResponse, MAX_RESPONSE_BYTES };
