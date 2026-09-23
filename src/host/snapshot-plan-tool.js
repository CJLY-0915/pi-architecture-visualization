'use strict';

const { readModel } = require('./read-model');
const { boundResponse } = require('./analysis-tools');
const { planSnapshotSave } = require('../core/persistence');
const { CODES } = require('../core/error-codes');
const manifest = require('../../manifest.json');

const SNAPSHOT_PLAN_TOOL = 'architecture_snapshot_plan';

function failure(code, message) {
  return { ok: false, error: { code, message } };
}

function createSnapshotPlanTool(host) {
  const definition = manifest.contributes.agentTools.find((entry) => entry.name === SNAPSHOT_PLAN_TOOL);
  if (!definition) throw new Error(`Missing tool declaration: ${SNAPSHOT_PLAN_TOOL}`);
  return {
    ...definition,
    execute: async (request) => {
      try {
        if (!request || typeof request !== 'object' || Array.isArray(request)
          || typeof request.path !== 'string' || request.path === '') {
          return failure(CODES.INVALID_OPTION, 'A workspace-relative model path is required.');
        }
        const loaded = await readModel(host, request.path);
        if (!loaded.ok) return loaded;
        return boundResponse(planSnapshotSave({ model: loaded.model }));
      } catch {
        return failure(CODES.INTERNAL_ERROR, 'Snapshot planning failed unexpectedly; no save was attempted.');
      }
    },
  };
}

module.exports = { SNAPSHOT_PLAN_TOOL, createSnapshotPlanTool };
