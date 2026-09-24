'use strict';

const { validateModel } = require('../core/validation');
const { planSnapshotSave } = require('../core/persistence');
const { isSafeRelativePath } = require('./read-model.js');

// The only write this plugin performs. Every decision is checked again at write
// time, so a plan the panel showed can never carry a stale "the target is
// missing" into an overwrite of a file that appeared in between.
const SAVE_DECISIONS = Object.freeze(['create', 'snapshot', 'overwrite']);
const DEFAULT_MODEL_PATH = 'architecture/model.json';
const HOST_ERROR_CODES = ['PERMISSION_DENIED', 'NOT_FOUND', 'INVALID_ARGUMENT'];

function failure(code, message, extra) {
  return { ok: false, error: Object.assign({ code, message }, extra) };
}

function modelCounts(model) {
  return {
    nodes: model.nodes.length,
    edges: model.edges.length,
    evidence: model.evidence.length,
    sourceRevision: model.sourceRevision ?? null,
    generatedAt: model.generatedAt,
  };
}

/**
 * Validates the model a save request carries and plans its canonical text.
 *
 * A model that fails structural validation is never written: saving it would
 * make the next read refuse it, which is a worse state than not saving at all.
 */
function resolveSaveModel(model) {
  if (model === null || typeof model !== 'object' || Array.isArray(model)) {
    return failure('invalid_option', 'A save request carries the model itself, not a path.');
  }
  const planned = planSnapshotSave({ model });
  if (!planned.ok) {
    return failure('INVALID_MODEL', 'The model failed structural validation, so nothing was written.', {
      validation: planned.validation,
    });
  }
  return planned;
}

/**
 * Reports whether a path is there, without treating a refusal as absence.
 *
 * NOT_FOUND is the host answering "there is no such file" and is the one
 * refusal that does mean absence. Anything else proves nothing, so it is
 * `unknown`: claiming a missing target that could not be seen is how a silent
 * overwrite starts.
 */
async function inspect(host, path) {
  let info;
  try {
    info = await host.fs.stat(path);
  } catch (error) {
    if (error && error.code === 'NOT_FOUND') return { state: 'missing' };
    return { state: 'unknown' };
  }
  if (!info || !Number.isSafeInteger(info.size) || info.size < 0) return { state: 'unknown' };
  return { state: 'present', bytes: info.size };
}

async function describeExisting(host, path) {
  let text;
  try {
    text = await host.fs.readText(path);
  } catch {
    return { readable: false };
  }
  if (typeof text !== 'string') return { readable: false };
  let model;
  try {
    model = JSON.parse(text);
  } catch {
    return { readable: false };
  }
  const validation = validateModel(model);
  if (!validation.valid) return { readable: true, valid: false };
  return { readable: true, valid: true, ...modelCounts(model) };
}

/**
 * States what a save would do, without doing it.
 *
 * The panel shows this before any button that writes, so the target, whether it
 * exists, and the node/edge/evidence counts on both sides are visible first.
 */
async function planModelSave(host, request) {
  const target = request.path;
  if (!isSafeRelativePath(target)) {
    return failure('INVALID_PATH', 'Use a workspace-relative target path without traversal.');
  }
  const resolved = resolveSaveModel(request.model);
  if (!resolved.ok) return resolved;

  const [atTarget, atSnapshot] = await Promise.all([
    inspect(host, target),
    inspect(host, resolved.path),
  ]);
  const save = {
    path: target,
    targetState: atTarget.state,
    targetBytes: atTarget.state === 'present' ? atTarget.bytes : null,
    // `recheck` covers both "a file is already there" and "the target could not
    // be inspected": neither is a state a create may act on.
    action: atTarget.state === 'missing' ? 'create' : 'recheck',
    snapshotPath: resolved.path,
    snapshotPresent: atSnapshot.state === 'present',
    new: modelCounts(request.model),
    existing: null,
  };
  if (atTarget.state === 'present') save.existing = await describeExisting(host, target);
  return { ok: true, save };
}

/**
 * Writes the model, but only in the shape the decision names.
 *
 * `create` refuses a target that is no longer absent, `overwrite` refuses a
 * target it could not inspect, and `snapshot` writes a content-addressed copy
 * and skips the write when that content is already on disk.
 */
async function applyModelSave(host, request) {
  const target = request.path;
  const decision = request.decision;
  if (!isSafeRelativePath(target)) {
    return failure('INVALID_PATH', 'Use a workspace-relative target path without traversal.');
  }
  const resolved = resolveSaveModel(request.model);
  if (!resolved.ok) return resolved;

  const atTarget = await inspect(host, target);
  if (decision === 'create' && atTarget.state !== 'missing') {
    return failure('TARGET_EXISTS', 'The target path is no longer absent, so nothing was written. Re-check the target state.');
  }
  if (decision === 'overwrite' && atTarget.state === 'unknown') {
    return failure('TARGET_STATE_UNKNOWN', 'The target could not be inspected, so it was not overwritten.');
  }

  const save = {
    decision,
    path: target,
    targetState: atTarget.state,
    targetBytes: atTarget.state === 'present' ? atTarget.bytes : null,
    new: modelCounts(request.model),
    existing: null,
    written: false,
    alreadyPresent: false,
    bytes: null,
    verified: false,
  };
  if (atTarget.state === 'present') save.existing = await describeExisting(host, target);

  if (decision === 'snapshot') {
    save.path = resolved.path;
    const atSnapshot = await inspect(host, resolved.path);
    if (atSnapshot.state === 'present') {
      save.alreadyPresent = true;
      return { ok: true, save };
    }
  }

  const text = resolved.text;
  const bytes = Buffer.byteLength(text, 'utf8');
  try {
    await host.fs.writeText(save.path, text);
  } catch (error) {
    const code = error && HOST_ERROR_CODES.includes(error.code) ? error.code : 'WRITE_FAILED';
    return failure(code, 'The host could not write the model file.');
  }
  const after = await inspect(host, save.path);
  if (after.state !== 'present' || after.bytes !== bytes) {
    return failure('WRITE_UNVERIFIED', 'The write could not be confirmed at the expected size, so the result is not reported as saved.');
  }
  save.written = true;
  save.bytes = bytes;
  save.verified = true;
  return { ok: true, save };
}

module.exports = {
  planModelSave,
  applyModelSave,
  SAVE_DECISIONS,
  DEFAULT_MODEL_PATH,
};
