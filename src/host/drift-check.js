'use strict';

// Host side of the architecture drift check.
//
// Drift answers one question: does a declared model still describe the
// workspace it claims to describe? The decision is made on file paths only.
// No Git state is read, so a file that still exists and is still cited may
// have changed without this check noticing; no source content is read either,
// so freshness is path presence and nothing more. Both limits travel with the
// result instead of living in a comment.
//
// The expensive half is the scan, so it stays here rather than in a core
// module: the collector runs once, the declared model is compared against what
// that scan actually modelled, and nothing is written.

const { collectModel } = require('../collectors/index.js');
const { createHostSource } = require('./fs-source.js');
const { readModel, resolveInlineModel } = require('./read-model.js');
const { computeDrift } = require('../core/drift.js');

const MAX_FINDINGS_LIMIT = 1000;
const MAX_DIAGNOSTICS = 100;
const ALLOWED_KEYS = ['model', 'path', 'scopeRoots', 'maxFiles', 'maxFindings'];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidOption(message) {
  return { ok: false, error: { code: 'invalid_option', message } };
}

// A scope root follows the collector's rules: "." is the whole workspace, and
// anything else is a relative path without traversal. A caller-supplied root
// must never be able to steer the traversal outside the workspace.
function isSafeScopeRoot(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  if (value === '.') return true;
  if (value.startsWith('/')) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

// The workspace payload can name several local folders while `pi.fs` resolves
// against the primary root only, so the rest are unreachable and are reported
// as a gap rather than silently missing from the comparison.
function unreachableRoots(workspaceMeta) {
  const primary = typeof workspaceMeta.path === 'string' && workspaceMeta.path !== '' ? workspaceMeta.path : null;
  if (!Array.isArray(workspaceMeta.roots)) return [];
  return workspaceMeta.roots
    .map((root) => (root !== null && typeof root === 'object' && typeof root.path === 'string' && root.path !== '' ? root.path : null))
    .filter((root) => root !== null && root !== primary);
}

function checkRequest(request) {
  if (!isPlainObject(request)) return invalidOption('The drift check accepts an object.');
  const unknown = Object.keys(request).filter((key) => !ALLOWED_KEYS.includes(key));
  if (unknown.length > 0) {
    return invalidOption(`Unknown drift option(s): ${unknown.join(', ')}.`);
  }
  if (request.maxFindings !== undefined
    && (!Number.isSafeInteger(request.maxFindings) || request.maxFindings < 1 || request.maxFindings > MAX_FINDINGS_LIMIT)) {
    return invalidOption(`maxFindings must be an integer between 1 and ${MAX_FINDINGS_LIMIT}.`);
  }
  if (request.maxFiles !== undefined && (!Number.isSafeInteger(request.maxFiles) || request.maxFiles <= 0)) {
    return invalidOption('maxFiles must be a positive safe integer.');
  }
  if (request.scopeRoots !== undefined
    && (!Array.isArray(request.scopeRoots) || request.scopeRoots.length === 0 || !request.scopeRoots.every(isSafeScopeRoot))) {
    return invalidOption('scopeRoots must be a nonempty array of workspace-relative POSIX paths without traversal.');
  }
  if (request.path !== undefined && (typeof request.path !== 'string' || request.path.length === 0 || request.path.length > 1024)) {
    return invalidOption('path must be a bounded workspace-relative model file path.');
  }
  return null;
}

function readHost(pi) {
  return { fs: { stat: (path) => pi.fs.stat(path), readText: (path) => pi.fs.readText(path) } };
}

// The declared side comes from the same two sources the analysis channels use,
// so a model collected in this session can be checked before anyone saves it.
async function resolveDeclaredModel(pi, request) {
  if (request.model !== undefined) return resolveInlineModel(request.model);
  if (typeof request.path !== 'string' || request.path.length === 0) {
    return invalidOption('Provide a model or a bounded workspace-relative model path.');
  }
  return readModel(readHost(pi), request.path);
}

async function scanWorkspace(pi, request, declaredModel) {
  let workspace = null;
  try {
    workspace = await pi.workspace.get();
  } catch {
    workspace = null;
  }
  const workspaceMeta = isPlainObject(workspace) ? workspace : {};
  const scopeRoots = request.scopeRoots === undefined ? ['.'] : request.scopeRoots;
  const host = createHostSource(pi, { scopeRoots });
  const extra = unreachableRoots(workspaceMeta);
  if (extra.length > 0) {
    host.limits.push({
      code: 'source_roots_partial',
      path: '',
      message: `This project has ${extra.length + 1} local folders and only the primary one was enumerated; the rest were not scanned.`,
    });
  }
  const enumerated = await host.source.listFiles();
  const project = isPlainObject(declaredModel.project) ? declaredModel.project : {};
  const options = {
    projectId: typeof project.id === 'string' && project.id !== '' ? project.id : 'workspace',
    generatedAt: new Date().toISOString(),
    scopeRoots,
  };
  if (Number.isSafeInteger(request.maxFiles) && request.maxFiles > 0) options.maxFiles = request.maxFiles;
  // The collector walks the workspace again for content; handing it the list we
  // already took keeps one traversal instead of two and puts both halves of the
  // comparison on exactly the same file set.
  const source = { listFiles: async () => enumerated, readText: host.source.readText };
  let collected;
  try {
    collected = await collectModel({ source, options, sourceDiagnostics: host.limits });
  } catch {
    return { ok: false, error: { code: 'COLLECT_FAILED', message: 'The drift check could not scan the workspace; no comparison was made.' } };
  }
  if (!isPlainObject(collected) || !isPlainObject(collected.model)) {
    return { ok: false, error: { code: 'COLLECT_FAILED', message: 'The workspace scan produced no model; no comparison was made.' } };
  }
  return { ok: true, host, enumerated, collected };
}

/**
 * Compares a declared architecture model against a fresh read-only scan of the
 * workspace and reports where the two disagree on file paths.
 *
 * @param {{workspace: {get: Function}, fs: {list: Function, readText: Function}}} pi Host API object.
 * @param {{model?: object, path?: string, scopeRoots?: string[], maxFiles?: number, maxFindings?: number}} request
 * @returns {Promise<object>} The drift result plus a `scan` block describing what was enumerated.
 */
async function runDriftCheck(pi, request) {
  const rejected = checkRequest(request);
  if (rejected) return rejected;

  const declared = await resolveDeclaredModel(pi, request);
  if (!declared.ok) return declared;

  const scan = await scanWorkspace(pi, request, declared.model);
  if (!scan.ok) return scan;

  const modelled = scan.collected.model.evidence
    .map((entry) => (isPlainObject(entry) && typeof entry.path === 'string' && entry.path !== '' ? entry.path : null))
    .filter((path) => path !== null);

  const result = computeDrift({
    model: declared.model,
    observed: {
      enumerated: scan.host.listed,
      modelled,
      complete: scan.collected.coverage.complete === true,
      limits: scan.host.limits,
    },
    maxFindings: request.maxFindings,
  });

  return {
    ...result,
    scan: {
      filesEnumerated: scan.host.listed.length,
      filesModelled: modelled.length,
      coverage: scan.collected.coverage,
      diagnostics: scan.collected.diagnostics.slice(0, MAX_DIAGNOSTICS),
    },
  };
}

module.exports = { runDriftCheck };
