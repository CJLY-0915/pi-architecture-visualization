const { readModel, resolveInlineModel, isSafeRelativePath } = require('./src/host/read-model.js');
const { createAnalysisTools, executeAnalysis, ANALYSIS_TOOL_NAMES, boundResponse, toolDefinition } = require('./src/host/analysis-tools.js');
const { SNAPSHOT_PLAN_TOOL, createSnapshotPlanTool } = require('./src/host/snapshot-plan-tool.js');
const { createHealthTool, executeHealth, HEALTH_TOOL } = require('./src/host/health-tool.js');
const { exportPreview } = require('./src/core/export-preview.js');
const { collectModel } = require('./src/collectors/index.js');
const { createHostSource } = require('./src/host/fs-source.js');
const { planModelSave, applyModelSave, SAVE_DECISIONS, DEFAULT_MODEL_PATH } = require('./src/host/save-model.js');

const VALIDATE_TOOL = 'architecture_validate';
const COLLECT_TOOL = 'architecture_collect';

// The manifest is the single declaration source for every agent tool: name,
// description, risk and schema all come from there, so the panel-facing docs and
// the runtime registration cannot drift apart.
function toolDeclaration(name) {
  const definition = toolDefinition(name);
  if (!definition) throw new Error(`Missing tool declaration: ${name}`);
  return definition;
}
const PANEL_ANALYSIS_CHANNELS = Object.freeze({
  'architecture.query': 'architecture_query',
  'architecture.impact': 'architecture_impact',
  'architecture.compare': 'architecture_compare',
  'architecture.exportPreview': 'architecture_export_preview',
  'architecture.health': 'architecture_health',
  'architecture.collect': 'architecture_collect',
});

// Keep the permission-gated call visible at the entry point while the shared
// readers remain independently testable with a tiny host adapter.
function readHost() {
  return { fs: { stat: (path) => pi.fs.stat(path), readText: (path) => pi.fs.readText(path) } };
}
const SAVE_CHANNEL = 'architecture.save';

// Writing needs one more permission than reading, so the call stays visible at
// the entry point rather than hiding inside the shared module.
function writeHost() {
  return {
    fs: {
      stat: (path) => pi.fs.stat(path),
      readText: (path) => pi.fs.readText(path),
      writeText: (path, content) => pi.fs.writeText(path, content),
    },
  };
}

// The panel addresses one channel more than the analysis tools do: saving is
// not an agent tool, because no tool schema carries a whole model.
const PANEL_CHANNELS = Object.freeze([...Object.keys(PANEL_ANALYSIS_CHANNELS), SAVE_CHANNEL].sort());

// This plugin budgets its own collection responses, independently of host import limits.
const MAX_SUMMARY_BYTES = 240 * 1024;
const MAX_SUMMARY_NODES = 150;
const MAX_SUMMARY_EDGES = 300;
const MAX_SUMMARY_ENTRIES = 100;

// "." is a valid scope root (the whole workspace) but never a valid file path.
function isSafeScopeRoot(value) {
  return value === '.' || isSafeRelativePath(value);
}

async function validatePath(args) {
  const result = await readModel(readHost(), args && args.path);
  return result.validation || { valid: false, error: result.error };
}

function summarize(result) {
  const { model } = result;
  const summary = {
    ok: result.ok,
    coverage: result.coverage,
    counts: { nodes: model.nodes.length, edges: model.edges.length, evidence: model.evidence.length },
    nodes: model.nodes.slice(0, MAX_SUMMARY_NODES).map(({ id, name, type, status, confidence, evidenceIds }) =>
      ({ id, name, type, status, confidence, evidenceIds })),
    edges: model.edges.slice(0, MAX_SUMMARY_EDGES).map(({ id, source, target, type, status, evidenceIds }) =>
      ({ id, source, target, type, status, evidenceIds })),
    evidence: model.evidence.slice(0, MAX_SUMMARY_ENTRIES),
    unresolved: result.unresolved.slice(0, MAX_SUMMARY_ENTRIES),
    diagnostics: result.diagnostics.slice(0, MAX_SUMMARY_ENTRIES),
    validation: { valid: result.validation.valid, diagnostics: result.validation.diagnostics.slice(0, MAX_SUMMARY_ENTRIES) },
  };
  const lists = [
    ['nodes', summary.nodes, model.nodes.length],
    ['edges', summary.edges, model.edges.length],
    ['evidence', summary.evidence, model.evidence.length],
    ['unresolved', summary.unresolved, result.unresolved.length],
    ['diagnostics', summary.diagnostics, result.diagnostics.length],
    ['validationDiagnostics', summary.validation.diagnostics, result.validation.diagnostics.length],
  ];
  function updateOmissions() {
    const omitted = Object.fromEntries(lists.filter(([, items, total]) => total > items.length)
      .map(([key, items, total]) => [key, total - items.length]));
    if (Object.keys(omitted).length) {
      summary.truncated = omitted;
      summary.truncatedNote = 'Only the first entries are listed; nothing was written. Omitted evidence may be referenced by evidenceIds.';
    }
  }
  updateOmissions();
  while (Buffer.byteLength(JSON.stringify(summary), 'utf8') > MAX_SUMMARY_BYTES) {
    const largest = lists.filter(([, items]) => items.length)
      .sort((a, b) => Buffer.byteLength(JSON.stringify(b[1]), 'utf8') - Buffer.byteLength(JSON.stringify(a[1]), 'utf8'))[0];
    if (largest === undefined) break;
    largest[1].pop();
    updateOmissions();
  }
  return summary;
}

async function collectCurrentState(args) {
  const request = args && typeof args === 'object' ? args : {};

  // `pi.workspace.get()` reports the folder the window is showing, while `pi.fs`
  // resolves paths against the project of the calling session (host ADR 0016).
  // The two can disagree, so an empty workspace payload is not fatal by itself:
  // the traversal decides, and only a root that cannot be listed at all is
  // reported as "no workspace open". Treating the payload as authoritative would
  // reject a session whose files are perfectly readable.
  let workspace = null;
  try {
    workspace = await pi.workspace.get();
  } catch {
    workspace = null;
  }
  const workspaceMeta = workspace !== null && typeof workspace === 'object' ? workspace : {};
  const workspacePath = typeof workspaceMeta.path === 'string' && workspaceMeta.path !== '' ? workspaceMeta.path : null;

  if (request.scopeRoots !== undefined && (!Array.isArray(request.scopeRoots)
    || request.scopeRoots.length === 0 || !request.scopeRoots.every(isSafeScopeRoot))) {
    return { ok: false, error: { code: 'INVALID_SCOPE', message: 'scopeRoots must be a nonempty array of workspace-relative POSIX paths without traversal.' } };
  }
  if (request.maxFiles !== undefined && (!Number.isSafeInteger(request.maxFiles) || request.maxFiles <= 0)) {
    return { ok: false, error: { code: 'INVALID_OPTION', message: 'maxFiles must be a positive safe integer.' } };
  }
  const scopeRoots = request.scopeRoots === undefined ? ['.'] : request.scopeRoots;
  // A project can be registered as several local folders; `pi.fs` resolves every
  // path against the primary root only, so the other roots are not reachable and
  // must be reported as a gap rather than silently missing from the model.
  const extraRoots = Array.isArray(workspaceMeta.roots)
    ? workspaceMeta.roots.map((root) => root && root.path).filter((root) => typeof root === 'string' && root !== '')
      .filter((root) => root !== workspacePath)
    : [];

  // `projectId` is the stable identity the host reports and is often an opaque
  // UUID, so it stays the id. The workspace name is what a person recognises and
  // goes into `project.name`; without it the panel has nothing to show but the
  // UUID, which is exactly what a collected model used to display.
  const options = {
    projectId: typeof workspaceMeta.projectId === 'string' && workspaceMeta.projectId !== ''
      ? workspaceMeta.projectId
      : (typeof workspaceMeta.name === 'string' && workspaceMeta.name !== '' ? workspaceMeta.name : 'workspace'),
    generatedAt: new Date().toISOString(),
    scopeRoots,
  };
  if (typeof workspaceMeta.name === 'string' && workspaceMeta.name.trim() !== '') options.projectName = workspaceMeta.name;
  if (Number.isInteger(request.maxFiles) && request.maxFiles > 0) options.maxFiles = request.maxFiles;

  const host = createHostSource(pi, { scopeRoots });
  if (extraRoots.length > 0) {
    host.limits.push({
      code: 'source_roots_partial',
      path: '',
      message: `This project has ${extraRoots.length + 1} local folders and only the primary one was enumerated; the rest were not scanned.`,
    });
  }

  let result;
  try {
    result = await collectModel({ source: host.source, options, sourceDiagnostics: host.limits });
  } catch (error) {
    return { ok: false, error: { code: 'COLLECT_FAILED', message: 'The collector failed before producing a model.' } };
  }
  // Nothing was reachable below the primary root: the session has no readable
  // project, which is what "no workspace is open" means for this call.
  if (result.coverage.filesListed === 0 && !result.coverage.complete
    && result.diagnostics.some((entry) => entry.code === 'source_list_failed' && entry.path === '')) {
    return { ok: false, error: { code: 'NO_WORKSPACE', message: 'Open a project folder before collecting its architecture.' } };
  }

  const summary = summarize(result);
  // `includeModel` is the panel-only switch that makes a fresh scan queryable
  // without writing a file: the summary stays bounded, the model travels whole
  // because the panel bridge has no byte budget of its own.
  if (request.includeModel === true) {
    if (!result.ok) return summary;
    return { ...summary, model: result.model };
  }
  return summary;
}

async function onLoad() {
  const cleanup = [];
  try {
    await pi.commands.register({
      id: 'architecture-visualization.open',
      title: 'Architecture: Open Workbench',
      keywords: ['architecture', 'diagram', '架构', '可视化'],
      run: async () => pi.ui.openPanel({ title: 'Architecture Visualization' }),
    });
    cleanup.push(() => pi.commands.unregister('architecture-visualization.open'));

    await pi.commands.register({
      id: 'architecture-visualization.validate',
      title: 'Architecture: Validate Model',
      keywords: ['architecture', 'validate', 'health', '校验', '健康'],
      run: async () => {
        const result = await validatePath({ path: 'architecture/model.json' });
        await pi.ui.showToast(result.valid ? '架构模型结构校验通过（未核验源文件内容）。' : `架构模型校验失败：${result.error ? result.error.code : result.diagnostics.length + ' 项诊断'}`);
        return result;
      },
    });
    cleanup.push(() => pi.commands.unregister('architecture-visualization.validate'));

    await pi.commands.register({
      id: 'architecture-visualization.collect',
      title: 'Architecture: Collect Current State',
      keywords: ['architecture', 'collect', 'scan', '采集', '扫描'],
      run: async () => {
        const result = await collectCurrentState({});
        await pi.ui.showToast(result.ok === false
          ? `架构采集失败：${result.error ? result.error.code : '模型或采集诊断未通过'}`
          : `架构采集完成：${result.counts.nodes} 节点 / ${result.counts.edges} 关系，证据 ${result.counts.evidence} 条，覆盖${result.coverage.complete ? '完整' : '不完整'}。仅扫描，未写入。`);
        return result;
      },
    });
    cleanup.push(() => pi.commands.unregister('architecture-visualization.collect'));

    await pi.agent.registerTool({ ...toolDeclaration(VALIDATE_TOOL), execute: validatePath });
    cleanup.push(() => pi.agent.unregisterTool(VALIDATE_TOOL));

    await pi.agent.registerTool({ ...toolDeclaration(COLLECT_TOOL), execute: collectCurrentState });
    cleanup.push(() => pi.agent.unregisterTool(COLLECT_TOOL));

    for (const tool of createAnalysisTools(readHost())) {
      await pi.agent.registerTool(tool);
      cleanup.push(() => pi.agent.unregisterTool(tool.name));
    }
    const snapshotPlanTool = createSnapshotPlanTool(readHost());
    await pi.agent.registerTool(snapshotPlanTool);
    cleanup.push(() => pi.agent.unregisterTool(SNAPSHOT_PLAN_TOOL));
    const healthTool = createHealthTool(readHost());
    await pi.agent.registerTool(healthTool);
    cleanup.push(() => pi.agent.unregisterTool(HEALTH_TOOL));
  } catch (error) {
    const results = await Promise.allSettled(cleanup.reverse().map(release => Promise.resolve().then(release)));
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError([error, ...failures], 'Plugin load and rollback failed');
    throw error;
  }
}

async function onUnload() {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => pi.agent.unregisterTool(VALIDATE_TOOL)),
    Promise.resolve().then(() => pi.agent.unregisterTool(COLLECT_TOOL)),
    ...ANALYSIS_TOOL_NAMES.map((name) => Promise.resolve().then(() => pi.agent.unregisterTool(name))),
    Promise.resolve().then(() => pi.agent.unregisterTool(SNAPSHOT_PLAN_TOOL)),
    Promise.resolve().then(() => pi.agent.unregisterTool(HEALTH_TOOL)),
    Promise.resolve().then(() => pi.commands.unregister('architecture-visualization.open')),
    Promise.resolve().then(() => pi.commands.unregister('architecture-visualization.validate')),
    Promise.resolve().then(() => pi.commands.unregister('architecture-visualization.collect')),
  ]);
  const failures = results.filter(result => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Plugin cleanup failed');
}

// Saving is reachable only from the panel: no agent tool schema carries a whole
// model, so the one write this plugin performs has no agent entry point.
async function saveFromPanel(payload) {
  const request = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  if (!request || Object.keys(request).some((key) => key !== 'model' && key !== 'path' && key !== 'decision')) {
    return { ok: false, error: { code: 'invalid_option', message: 'Save accepts the model, an optional target path and an optional decision.' } };
  }
  if (request.decision !== undefined && !SAVE_DECISIONS.includes(request.decision)) {
    return { ok: false, error: { code: 'invalid_option', message: 'A save decision must be create, snapshot or overwrite.' } };
  }
  const path = request.path === undefined ? DEFAULT_MODEL_PATH : request.path;
  if (request.decision === undefined) return planModelSave(writeHost(), { model: request.model, path });
  return applyModelSave(writeHost(), { model: request.model, path, decision: request.decision });
}

async function onPanelInvoke(channel, payload) {
  if (channel === SAVE_CHANNEL) return saveFromPanel(payload);
  const name = PANEL_ANALYSIS_CHANNELS[channel];
  if (!name) {
    return { ok: false, error: { code: 'unsupported_input', message: 'This panel operation is not available.' } };
  }
  if (name === 'architecture_collect') {
    // Collect has no model path: it scans the workspace through the same host
    // source the command and the agent tool use and returns the same bounded
    // summary, so the panel can show what the collector sees before any model
    // exists. `includeModel` additionally hands back the model itself, which is
    // what makes a fresh scan queryable without writing a file.
    const request = payload === undefined ? {} : payload;
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || Object.keys(request).some((key) => key !== 'scopeRoots' && key !== 'maxFiles' && key !== 'includeModel')) {
      return { ok: false, error: { code: 'invalid_option', message: 'Collect accepts only optional scopeRoots, maxFiles and includeModel.' } };
    }
    return collectCurrentState(request);
  }
  // A model the panel collected in this session replaces the file path, so the
  // whole read-model-analyse loop can run on a scan nobody saved yet.
  const { model: inlineModel, ...rest } = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  if (name === 'architecture_export_preview') {
    const request = rest && typeof rest === 'object' ? rest : null;
    // focus and level only mean anything to the C4 renderer; every other format
    // ignores them, so they are accepted here and validated there.
    const boundedFocus = Boolean(request) && (request.focus === undefined || (typeof request.focus === 'string' && request.focus.length > 0 && request.focus.length <= 1024));
    const needsPath = inlineModel === undefined;
    if (!request || typeof request.format !== 'string' || !boundedFocus
      || (needsPath && (typeof request.path !== 'string' || request.path.length === 0 || request.path.length > 1024))
      || Object.keys(request).some((key) => key !== 'path' && key !== 'format' && key !== 'focus' && key !== 'level')) {
      return { ok: false, error: { code: 'invalid_option', message: 'Provide a bounded model path, one preview format, and an optional bounded C4 focus node id.' } };
    }
    let model;
    if (inlineModel !== undefined) {
      const resolved = resolveInlineModel(inlineModel);
      if (!resolved.ok) return resolved;
      model = resolved.model;
    } else {
      const loaded = await readModel(readHost(), request.path);
      if (!loaded.ok) return loaded;
      model = loaded.model;
    }
    return boundResponse(exportPreview(model, request.format, { focus: request.focus, level: request.level }));
  }
  if (name === 'architecture_health') return executeHealth(readHost(), rest, inlineModel);
  return executeAnalysis(readHost(), name, rest, inlineModel);
}
// `summarize` and the budget constants are exported so the response bounding
// can be tested without a host; the entry points stay the only `pi` callers.
module.exports = {
  onLoad, onUnload, onPanelInvoke, PANEL_ANALYSIS_CHANNELS, PANEL_CHANNELS, SAVE_CHANNEL,
  summarize, MAX_SUMMARY_BYTES, MAX_SUMMARY_NODES, MAX_SUMMARY_EDGES, MAX_SUMMARY_ENTRIES,
};
