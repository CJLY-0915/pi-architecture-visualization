'use strict';

const { readModel, resolveInlineModel } = require('./read-model');
const { boundResponse } = require('./analysis-tools');
const { healthCheck } = require('../core/health');
const manifest = require('../../manifest.json');

const HEALTH_TOOL = 'architecture_health';

function definition() {
  return manifest.contributes.agentTools.find((entry) => entry.name === HEALTH_TOOL) || null;
}

function fail(code, message) {
  return { ok: false, error: { code, message } };
}

async function executeHealth(host, request, inlineModel) {
  try {
    const tool = definition();
    if (!tool) return fail('unsupported_input', 'Architecture health is not declared.');
    const acceptsInline = inlineModel !== undefined;
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || (!acceptsInline && (typeof request.path !== 'string' || request.path.length === 0 || request.path.length > 1024))
      || Object.keys(request).some((key) => key !== 'path')) {
      return fail('invalid_option', 'Provide exactly one workspace-relative model path.');
    }
    // Health is the one reader that needs validator findings for an invalid
    // parsed document. It still rejects bad paths, failed reads and invalid JSON.
    const loaded = acceptsInline
      ? resolveInlineModel(inlineModel, { allowInvalidModel: true })
      : await readModel(host, request.path, { allowInvalidModel: true });
    if (!loaded.ok) return loaded;
    const document = loaded.model !== null && typeof loaded.model === 'object' && !Array.isArray(loaded.model) ? loaded.model : {};
    return boundResponse({ ...healthCheck(loaded.model), sourceContentVerified: false, modelContext: { project: document.project, scope: document.scope, sourceRevision: document.sourceRevision, coverage: document.coverage } });
  } catch {
    return fail('internal_error', 'Health check failed unexpectedly; no complete result was produced.');
  }
}

function createHealthTool(host) {
  const tool = definition();
  if (!tool) throw new Error('Missing health tool declaration');
  return { ...tool, execute: (request) => executeHealth(host, request) };
}

module.exports = { HEALTH_TOOL, executeHealth, createHealthTool };
