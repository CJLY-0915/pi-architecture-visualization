'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const model = require('../fixtures/valid-minimal-model.json');

class Element {
  constructor(id = '') {
    this.id = id;
    this.value = '';
    this.textContent = '';
    this.innerHTML = '';
    this.hidden = false;
    this.disabled = false;
    this.className = '';
    this.dataset = {};
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.style = { setProperty() {} };
  }

  get lastElementChild() { return this.children[this.children.length - 1] || null; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = [...items]; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  focus() {}
  dispatch(type, event = {}) {
    const listener = this.listeners.get(type);
    assert.ok(listener, `${this.id || 'element'} must handle ${type}`);
    return listener({ preventDefault() {}, ...event });
  }
}

function extractPanelScript() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const match = /<script>\s*([\s\S]*?)\s*<\/script>/.exec(html);
  assert.ok(match, 'renderer must contain one executable inline script');
  return match[1];
}

function createPanelHarness(respond) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const elements = new Map();
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) elements.set(match[1], new Element(match[1]));
  const coverageMarkup = /<p id="coverage-warning"[^>]*>([\s\S]*?)<\/p>/.exec(html);
  assert.ok(coverageMarkup, 'coverage warning markup must exist');
  const coverageSpans = [...coverageMarkup[1].matchAll(/<span\b/g)].length;
  assert.equal(coverageSpans, 2, 'coverage warning must retain its icon and message spans');
  for (let index = 0; index < coverageSpans; index += 1) elements.get('coverage-warning').append(new Element());
  elements.get('model-path').value = 'architecture/model.json';
  elements.get('query-mode').value = 'filter';
  elements.get('impact-direction').value = 'downstream';
  elements.get('export-format').value = 'mermaid';
  const calls = [];
  const document = {
    getElementById(id) { return elements.get(id) || null; },
    createElement() { return new Element(); },
    querySelectorAll(selector) { assert.equal(selector, '.analysis-form input, .analysis-form select, .analysis-form button'); return ['query-mode', 'query-targets', 'query-to', 'impact-targets', 'impact-direction', 'changeset-paths', 'changeset-direction', 'compare-before', 'compare-after', 'export-format', 'query-form', 'impact-form', 'changeset-form', 'compare-form', 'export-form', 'health-form'].map((id) => elements.get(id)); },
  };
  const window = {
    pluginBridge: {
      invoke: async (channel, payload) => {
        calls.push({ channel, payload });
        return respond(channel, payload);
      },
    },
  };
  vm.runInNewContext(extractPanelScript(), { window, document, console, JSON, String, Number, Array, Object, Set, Map, RegExp });
  return { elements, calls };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function containsText(element, text) {
  if (typeof element.textContent === 'string' && element.textContent.includes(text)) return true;
  return element.children.some((child) => containsText(child, text));
}
// Button labels are static markup and the harness double starts every element with empty text, so a label is asserted where it is written.
function saveActionLabels() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const match = /<div id="save-actions"[\s\S]*?<\/div>/.exec(html);
  assert.ok(match, 'the save actions row must exist in the renderer markup');
  return match[0];
}

test('panel loads a model, rejects ambiguous query input, and renders a bounded query result', async () => {
  const harness = createPanelHarness((channel) => {
    if (channel === 'workspace.get') return { path: 'E:/work/demo' };
    if (channel === 'fs.stat') return { size: Buffer.byteLength(JSON.stringify(model), 'utf8') };
    if (channel === 'fs.readText') return JSON.stringify(model);
    if (channel === 'architecture.query') return {
      ok: true,
      sourceContentVerified: false,
      modelContext: { coverage: model.coverage },
      nodes: [{ id: 'container.api', type: 'container', status: 'confirmed', confidence: 'high' }],
      stats: { totalNodes: 1, truncated: false },
    };
    throw new Error(`unexpected panel channel: ${channel}`);
  });
  const { elements, calls } = harness;

  elements.get('load-form').dispatch('submit');
  await settle();
  assert.equal(elements.get('reader').hidden, false);
  assert.equal(elements.get('status').dataset.kind, 'ready');
  assert.equal(elements.get('project-name').textContent, 'Sample Billing Monolith');
  assert.equal(elements.get('node-list').children.length, model.nodes.length);
  assert.deepEqual(calls.slice(0, 3).map((call) => call.channel), ['workspace.get', 'fs.stat', 'fs.readText']);

  elements.get('query-mode').value = 'neighbours';
  elements.get('query-targets').value = '';
  const callCount = calls.length;
  elements.get('query-form').dispatch('submit');
  assert.equal(elements.get('analysis-status').dataset.kind, 'error');
  assert.equal(calls.length, callCount, 'missing targets must not reach the bridge');

  elements.get('query-targets').value = 'container.api';
  elements.get('query-form').dispatch('submit');
  await settle();
  assert.equal(calls.at(-1).channel, 'architecture.query');
  assert.equal(calls.at(-1).payload.path, 'architecture/model.json');
  assert.equal(elements.get('analysis-status').dataset.kind, 'ready');
  assert.ok(containsText(elements.get('analysis-results'), '源文件内容未重新验证'));
  assert.ok(containsText(elements.get('analysis-results'), 'container.api'));
});

test('panel keeps preview truncation and invalid-model health findings visible', async () => {
  const harness = createPanelHarness((channel) => {
    if (channel === 'workspace.get') return { path: 'E:/work/demo' };
    if (channel === 'fs.stat') return { size: Buffer.byteLength(JSON.stringify(model), 'utf8') };
    if (channel === 'fs.readText') return JSON.stringify(model);
    if (channel === 'architecture.exportPreview') return {
      ok: true, format: 'markdown', mimeType: 'text/markdown', supported: true,
      content: '# preview', contentTruncated: true, metadata: { schemaVersion: 1 }, legend: [],
      limitations: ['仅内存预览：没有写入。'],
    };
    if (channel === 'architecture.health') return {
      ok: false, sourceContentVerified: false, validation: { valid: false },
      findings: [{ severity: 'error', category: 'conflicts', code: 'dangling_edge_endpoint', kind: 'edge', id: 'edge.api.invoice', field: 'target', message: 'target does not resolve' }],
      counts: { findings: 1, errors: 1, warnings: 0, infos: 0 },
      unverified: { sourceContentVerified: false, evidenceFreshness: 'unknown', artifactFreshness: 'unknown' },
      limitations: ['Only the model was read.'],
    };
    throw new Error(`unexpected panel channel: ${channel}`);
  });
  const { elements } = harness;
  elements.get('load-form').dispatch('submit');
  await settle();

  elements.get('export-format').value = 'markdown';
  elements.get('export-form').dispatch('submit');
  await settle();
  assert.ok(containsText(elements.get('analysis-results'), '内容已受 24,000 字符内存预览预算截断'));
  assert.ok(containsText(elements.get('analysis-results'), '仅内存预览：没有写入。'));

  elements.get('health-form').dispatch('submit');
  await settle();
  assert.equal(elements.get('analysis-status').dataset.kind, 'ready');
  assert.ok(containsText(elements.get('analysis-results'), '模型合同未通过'));
  assert.ok(containsText(elements.get('analysis-results'), 'dangling_edge_endpoint'));
  assert.ok(containsText(elements.get('analysis-results'), 'evidenceFreshness'));
});

test('panel labels a valid health result with no findings accurately', async () => {
  const harness = createPanelHarness((channel) => {
    if (channel === 'workspace.get') return { path: 'E:/work/demo' };
    if (channel === 'fs.stat') return { size: Buffer.byteLength(JSON.stringify(model), 'utf8') };
    if (channel === 'fs.readText') return JSON.stringify(model);
    if (channel === 'architecture.health') return {
      ok: true, sourceContentVerified: false, validation: { valid: true }, findings: [],
      counts: { findings: 0, errors: 0, warnings: 0, infos: 0 },
      unverified: { sourceContentVerified: false, evidenceFreshness: 'unknown', artifactFreshness: 'unknown' }, limitations: [],
    };
    throw new Error(`unexpected panel channel: ${channel}`);
  });
  const { elements } = harness;
  elements.get('load-form').dispatch('submit');
  await settle();
  elements.get('health-form').dispatch('submit');
  await settle();
  assert.ok(containsText(elements.get('analysis-results'), '模型合同通过；未记录健康发现'));
  assert.ok(!containsText(elements.get('analysis-results'), '仍有健康发现'));
});

test('panel probes the collector before any model is loaded and keeps blind spots visible', async () => {
  const harness = createPanelHarness((channel) => {
    if (channel === 'architecture.collect') return {
      ok: true,
      coverage: { complete: false, filesListed: 12, filesScanned: 10, filesSkipped: 2, adapters: [{ id: 'js-ts', matched: 6, limited: false }] },
      counts: { nodes: 7, edges: 5, evidence: 9 },
      unresolved: [{ code: 'unsupported_input', path: 'config/jobs.yml', message: 'This configuration type is not modelled by this collector.' }],
      diagnostics: [],
      truncated: { evidence: 3 },
      truncatedNote: 'Only the first entries are listed; nothing was written.',
    };
    throw new Error(`unexpected panel channel: ${channel}`);
  });
  const { elements, calls } = harness;

  // No model is loaded: collect lives outside the reader on purpose.
  elements.get('collect-roots').value = 'src, config';
  elements.get('collect-max').value = '250';
  elements.get('collect-form').dispatch('submit');
  await settle();

  assert.deepEqual(calls.map((call) => call.channel), ['architecture.collect']);
  assert.equal(calls[0].payload.maxFiles, 250);
  assert.deepEqual([...calls[0].payload.scopeRoots], ['src', 'config']);
  assert.equal(elements.get('collect-status').dataset.kind, 'ready');
  assert.ok(containsText(elements.get('collect-results'), 'config/jobs.yml'));
  assert.ok(containsText(elements.get('collect-results'), 'unsupported_input'));
  assert.ok(containsText(elements.get('collect-results'), '采集过程不写入磁盘'));
  assert.ok(containsText(elements.get('collect-results'), '仅显示前 24') === false);

  // A non-positive file budget is refused locally instead of being guessed.
  elements.get('collect-max').value = '0';
  elements.get('collect-form').dispatch('submit');
  await settle();
  assert.equal(calls.length, 1, 'an invalid file budget must not reach the bridge');
  assert.equal(elements.get('collect-status').dataset.kind, 'error');
  assert.ok(containsText(elements.get('collect-status'), '正整数'));
});

test('a collected model becomes the active one and is analysed without a path', async () => {
  const collectedModel = JSON.parse(JSON.stringify(model));
  const harness = createPanelHarness((channel) => {
    if (channel === 'architecture.collect') return {
      ok: true,
      coverage: { complete: true, filesListed: 4, filesScanned: 4, filesSkipped: 0, adapters: [] },
      counts: { nodes: collectedModel.nodes.length, edges: collectedModel.edges.length, evidence: collectedModel.evidence.length },
      unresolved: [],
      diagnostics: [],
      model: collectedModel,
    };
    if (channel === 'architecture.query') return { ok: true, nodes: [], modelContext: {} };
    if (channel === 'architecture.health') return { ok: true, counts: {}, findings: [] };
    throw new Error(`unexpected panel channel: ${channel}`);
  });
  const { elements, calls } = harness;

  elements.get('collect-form').dispatch('submit');
  await settle();

  // The reader opens on the collected model, and the source is named so a
  // bounded summary is never mistaken for a saved file.
  assert.equal(elements.get('reader').hidden, false, 'collecting must open the reader');
  assert.equal(elements.get('model-source').textContent, '来自本次采集（未落盘）');
  assert.equal(elements.get('project-name').textContent, collectedModel.project.name, 'the reader must show the collected project');

  // Analysis now travels the model itself; no path is sent, because no file exists.
  elements.get('query-targets').value = 'module:core-model';
  elements.get('query-form').dispatch('submit');
  await settle();
  const query = calls.find((call) => call.channel === 'architecture.query');
  assert.ok(query, 'the panel must issue a query');
  assert.equal(query.payload.path, undefined, 'an unsaved model must not be addressed by path');
  assert.equal(query.payload.model.schemaVersion, 1);
  assert.equal(query.payload.model.nodes.length, collectedModel.nodes.length);

  elements.get('health-form').dispatch('submit');
  await settle();
  const health = calls.find((call) => call.channel === 'architecture.health');
  assert.ok(health);
  assert.equal(health.payload.path, undefined);
  assert.ok(health.payload.model);
});
test('collecting again withdraws a diagram drawn from the previous model', async () => {
  const collectedModel = JSON.parse(JSON.stringify(model));
  const harness = createPanelHarness((channel, payload) => {
    if (channel === 'workspace.get') return { path: 'E:/work/demo' };
    if (channel === 'fs.stat') return { size: Buffer.byteLength(JSON.stringify(model), 'utf8') };
    if (channel === 'fs.readText') return JSON.stringify(model);
    if (channel === 'architecture.collect') return {
      ok: true,
      coverage: { complete: true, filesListed: 4, filesScanned: 4, filesSkipped: 0, adapters: [] },
      counts: { nodes: collectedModel.nodes.length, edges: collectedModel.edges.length, evidence: collectedModel.evidence.length },
      unresolved: [],
      diagnostics: [],
      model: collectedModel,
    };
    if (channel === 'architecture.diagram') {
      const focused = typeof payload === 'object' && payload !== null && typeof payload.focus === 'string';
      return {
        ok: true,
        svg: '<svg viewBox="0 0 656 390"><g class="dg-node" data-node-id="container.api"><rect/></g></svg>',
        nodes: [{ id: 'container.api', name: 'API', type: 'container', status: 'confirmed', depth: 0 }],
        edges: [],
        focus: focused ? { id: 'container.api', name: 'API', neighbours: [] } : null,
        truncated: false, omitted: { nodes: 0, edges: 0 },
        layout: { layers: 2, width: 656, height: 390, maxNodes: 150, maxEdges: 300 },
        limitations: ['确定性分层布局，不是运行态拓扑。'],
      };
    }
    throw new Error(`unexpected panel channel: ${channel}`);
  });
  const { elements } = harness;

  elements.get('load-form').dispatch('submit');
  await settle();
  elements.get('diagram-draw').dispatch('click');
  await settle();
  assert.equal(elements.get('diagram-status').dataset.kind, 'ready', 'the diagram must be drawn first');
  assert.ok(elements.get('diagram-surface').innerHTML.includes('data-node-id'));

  // The new model is not the one the diagram was drawn from, so leaving it on
  // screen would put two different models side by side.
  elements.get('collect-form').dispatch('submit');
  await settle();
  assert.equal(elements.get('model-source').textContent, '来自本次采集（未落盘）');
  assert.equal(elements.get('diagram-status').dataset.kind, 'idle', 'a new model must withdraw the previous diagram');
  assert.equal(elements.get('diagram-surface').innerHTML, '', 'no diagram of a replaced model may stay on screen');
  assert.equal(elements.get('diagram-clear').hidden, true, 'a withdrawn diagram has no focus to clear');
  assert.equal(elements.get('diagram-zoom-in').hidden, true, 'a withdrawn diagram has no view to transform');
});

// The harness Element has no querySelectorAll, so walk the tree by class.
function findAllByClass(element, className, out = []) {
  const own = typeof element.className === 'string' ? element.className.split(/\s+/) : [];
  if (own.includes(className)) out.push(element);
  for (const child of element.children || []) findAllByClass(child, className, out);
  return out;
}
function findByClass(element, className) { return findAllByClass(element, className)[0] || null; }
function selectFirstNode(elements) {
  const row = elements.get('node-list').children[0];
  assert.ok(row, 'the node index must have rows');
  row.dispatch('click');
}

test('panel opens an evidence file and copies an export through host bridges only', async () => {
  const harness = createPanelHarness((channel) => {
    if (channel === 'workspace.get') return { path: 'E:/work/demo' };
    if (channel === 'fs.stat') return { size: Buffer.byteLength(JSON.stringify(model), 'utf8') };
    if (channel === 'fs.readText') return JSON.stringify(model);
    if (channel === 'architecture.exportPreview') return {
      ok: true, format: 'json', mimeType: 'application/json', supported: true,
      content: '{"schemaVersion":1}', contentTruncated: false, metadata: { schemaVersion: 1 }, legend: [], limitations: [],
    };
    if (channel === 'fs.openDefault') return { ok: true };
    if (channel === 'clipboard.writeText') return { ok: true };
    throw new Error(`unexpected panel channel: ${channel}`);
  });
  const { elements, calls } = harness;
  elements.get('load-form').dispatch('submit');
  await settle();
  selectFirstNode(elements);
  await settle();

  const openButtons = findAllByClass(elements.get('detail-body'), 'evidence-open');
  assert.ok(openButtons.length > 0, 'every evidence row with a path must offer an open action');
  openButtons[0].dispatch('click');
  await settle();
  const opened = calls.find((call) => call.channel === 'fs.openDefault');
  assert.ok(opened, 'opening evidence must go through the host bridge');
  assert.equal(typeof opened.payload.path, 'string');
  assert.ok(opened.payload.path.length > 0, 'the path must be sent verbatim, never rebuilt');
  assert.equal(elements.get('status').dataset.kind, 'ready');

  // The export offers a copy action instead of asking the user to hand-select
  // a multi-kilobyte <pre>.
  elements.get('export-format').value = 'json';
  elements.get('export-form').dispatch('submit');
  await settle();
  const copyButton = findAllByClass(elements.get('analysis-results'), 'button')
    .find((button) => button.textContent === '复制到剪贴板');
  assert.ok(copyButton, 'a supported export must offer a copy action');
  copyButton.dispatch('click');
  await settle();
  const copied = calls.find((call) => call.channel === 'clipboard.writeText');
  assert.ok(copied, 'copying must go through the host bridge');
  assert.equal(copied.payload.text, '{"schemaVersion":1}');
  assert.equal(copyButton.textContent, '已复制');
});

test('a refused evidence open is reported, not silently ignored', async () => {
  const harness = createPanelHarness((channel) => {
    if (channel === 'workspace.get') return { path: 'E:/work/demo' };
    if (channel === 'fs.stat') return { size: Buffer.byteLength(JSON.stringify(model), 'utf8') };
    if (channel === 'fs.readText') return JSON.stringify(model);
    if (channel === 'fs.openDefault') throw Object.assign(new Error('path escapes the plugin root'), { code: 'PERMISSION_DENIED' });
    throw new Error(`unexpected panel channel: ${channel}`);
  });
  const { elements, calls } = harness;
  elements.get('load-form').dispatch('submit');
  await settle();
  selectFirstNode(elements);
  await settle();

  const openButton = findByClass(elements.get('detail-body'), 'evidence-open');
  assert.ok(openButton, 'the evidence row must still be actionable');
  openButton.dispatch('click');
  await settle();

  assert.equal(calls.filter((call) => call.channel === 'fs.openDefault').length, 1);
  assert.equal(elements.get('status').dataset.kind, 'error');
  assert.ok(containsText(elements.get('status'), 'PERMISSION_DENIED'));
  // The evidence row stays on screen so the claim can still be checked by hand.
  assert.ok(findByClass(elements.get('detail-body'), 'evidence-open'));
});

test('collecting reveals the save block, and a create goes through the host bridge', async () => {
  const collectedModel = JSON.parse(JSON.stringify(model));
  const counts = { nodes: collectedModel.nodes.length, edges: collectedModel.edges.length, evidence: collectedModel.evidence.length };
  const plan = {
    path: 'architecture/model.json', targetState: 'missing', targetBytes: null, action: 'create',
    snapshotPath: `architecture/snapshots/${'a'.repeat(64)}.json`, snapshotPresent: false, new: counts, existing: null,
  };
  const saved = {
    decision: 'create', path: 'architecture/model.json', targetState: 'missing', targetBytes: null,
    new: counts, existing: null, written: true, alreadyPresent: false, bytes: 4096, verified: true,
  };
  const harness = createPanelHarness((channel, payload) => {
    if (channel === 'architecture.collect') {
      return { ok: true, coverage: { complete: true, filesListed: 4, filesScanned: 4, filesSkipped: 0, adapters: [] }, counts, unresolved: [], diagnostics: [], model: collectedModel };
    }
    if (channel === 'architecture.save') return payload.decision === undefined ? { ok: true, save: plan } : { ok: true, save: saved };
    if (channel === 'workspace.get') return { path: 'E:/work/demo' };
    if (channel === 'fs.stat') return { size: Buffer.byteLength(JSON.stringify(collectedModel), 'utf8') };
    if (channel === 'fs.readText') return JSON.stringify(collectedModel);
    throw new Error(`unexpected panel channel: ${channel}`);
  });
  const { elements, calls } = harness;

  elements.get('collect-form').dispatch('submit');
  await settle();

  // The save block appears with the collected model and asks the host what the
  // target looks like before any write is offered.
  assert.equal(elements.get('save').hidden, false, 'collecting must reveal the save block');
  assert.equal(elements.get('save-path').value, 'architecture/model.json');
  assert.equal(elements.get('save-state').dataset.kind, 'ready');
  assert.ok(containsText(elements.get('save-state'), '该路径不存在'));
  assert.equal(elements.get('save-create').hidden, false, 'a missing target offers a create');
  assert.match(saveActionLabels(), />创建<\/button>/, 'a write button names the action, never the path');
  assert.ok(containsText(elements.get('save-state'), 'architecture/model.json'), 'the target path stays visible next to the button');
  assert.equal(elements.get('save-overwrite').hidden, true, 'there is nothing to overwrite yet');
  assert.equal(elements.get('save-snapshot').hidden, true);

  const planned = calls.find((call) => call.channel === 'architecture.save');
  assert.ok(planned, 'the panel must ask for a plan first');
  assert.equal(planned.payload.decision, undefined, 'a plan request must not name a decision');
  assert.equal(planned.payload.path, 'architecture/model.json');
  assert.equal(planned.payload.model.schemaVersion, 1);

  elements.get('save-create').dispatch('click');
  await settle();
  const applied = calls.filter((call) => call.channel === 'architecture.save');
  assert.equal(applied.length, 2);
  assert.equal(applied[1].payload.decision, 'create');
  assert.equal(applied[1].payload.path, 'architecture/model.json');
  assert.ok(containsText(elements.get('save-results'), '已写入'));
  assert.ok(containsText(elements.get('save-results'), '4096'));

  // Writing the standard path closes the loop: the model is re-read from disk
  // and the panel stops treating it as an unsaved scan.
  assert.equal(elements.get('model-source').textContent, '来自文件 architecture/model.json');
  assert.equal(elements.get('save').hidden, true, 'a saved model no longer needs the save block');
  assert.equal(elements.get('status').dataset.kind, 'ready');
});

test('an existing target hides create and offers a snapshot and an explicit overwrite', async () => {
  const collectedModel = JSON.parse(JSON.stringify(model));
  const counts = { nodes: collectedModel.nodes.length, edges: collectedModel.edges.length, evidence: collectedModel.evidence.length };
  const snapshotPath = `architecture/snapshots/${'b'.repeat(64)}.json`;
  const harness = createPanelHarness((channel, payload) => {
    if (channel === 'architecture.collect') {
      return { ok: true, coverage: { complete: true, filesListed: 4, filesScanned: 4, filesSkipped: 0, adapters: [] }, counts, unresolved: [], diagnostics: [], model: collectedModel };
    }
    if (channel === 'architecture.save' && payload.decision === undefined) {
      return { ok: true, save: { path: payload.path, targetState: 'present', targetBytes: 3000, action: 'recheck', snapshotPath, snapshotPresent: false, new: counts, existing: { readable: true, valid: true, nodes: 3, edges: 2, evidence: 3 } } };
    }
    if (channel === 'architecture.save') {
      const isOverwrite = payload.decision === 'overwrite';
      return { ok: true, save: { decision: payload.decision, path: isOverwrite ? payload.path : snapshotPath, targetState: 'present', targetBytes: 3000, new: counts, existing: { readable: true, valid: true, nodes: 3, edges: 2, evidence: 3 }, written: isOverwrite, alreadyPresent: false, bytes: isOverwrite ? 4200 : null, verified: isOverwrite } };
    }
    throw new Error(`unexpected panel channel: ${channel}`);
  });
  const { elements, calls } = harness;

  elements.get('collect-form').dispatch('submit');
  await settle();

  assert.equal(elements.get('save-state').dataset.kind, 'warning');
  assert.ok(containsText(elements.get('save-state'), '该路径已有文件'));
  assert.ok(containsText(elements.get('save-state'), '现有模型：3 节点 / 2 关系 / 3 证据'));
  assert.equal(elements.get('save-create').hidden, true, 'an existing target must not offer a blind create');
  assert.equal(elements.get('save-snapshot').hidden, false);
  assert.equal(elements.get('save-overwrite').hidden, false);
  // The snapshot path is 88 characters; in a button label it pushed the other
  // two write buttons out of the row, so the label stays a verb and the path
  // is carried by the state line above.
  assert.match(saveActionLabels(), />另存为快照<\/button>/, 'the snapshot button must not carry the path in its label');
  assert.ok(!/architecture\//.test(saveActionLabels()), 'no save button label may interpolate a path');
  assert.ok(containsText(elements.get('save-state'), snapshotPath));
  assert.equal(elements.get('save-snapshot').title, `写入 ${snapshotPath}`);

  // A snapshot leaves the standard path alone, so the panel keeps treating the
  // scan as unsaved instead of pretending a file changed.
  elements.get('save-snapshot').dispatch('click');
  await settle();
  const applied = calls.filter((call) => call.channel === 'architecture.save').at(-1);
  assert.equal(applied.payload.decision, 'snapshot');
  assert.ok(containsText(elements.get('save-results'), 'snapshots/'));
  assert.equal(elements.get('model-source').textContent, '来自本次采集（未落盘）');
});
// A content-addressed snapshot path is a single 88-character token with no
// spaces, so a status line that cannot break it grows a horizontal scrollbar
// on the whole panel. Layout is not observable in the harness, so the rule is
// asserted where it is written.
function cssRuleBody(selector) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const style = /<style>([\s\S]*?)<\/style>/.exec(html);
  assert.ok(style, 'renderer must contain one style block');
  const rule = new RegExp(selector.replace(/[.]/g, '\\.') + '\\s*\\{([^}]*)\\}').exec(style[1]);
  assert.ok(rule, `${selector} must declare a rule in the renderer style block`);
  return rule[1];
}

test('every status line that can carry a path is allowed to break it', () => {
  for (const selector of ['.save-state', '.analysis-status']) {
    assert.match(cssRuleBody(selector), /overflow-wrap:\s*anywhere/, `${selector} must break a long path token instead of overflowing the panel`);
  }
});

test('a refused save is reported and the model stays in memory', async () => {
  const collectedModel = JSON.parse(JSON.stringify(model));
  const counts = { nodes: collectedModel.nodes.length, edges: collectedModel.edges.length, evidence: collectedModel.evidence.length };
  const harness = createPanelHarness((channel, payload) => {
    if (channel === 'architecture.collect') {
      return { ok: true, coverage: { complete: true, filesListed: 4, filesScanned: 4, filesSkipped: 0, adapters: [] }, counts, unresolved: [], diagnostics: [], model: collectedModel };
    }
    if (channel === 'architecture.save' && payload.decision === undefined) {
      return { ok: true, save: { path: payload.path, targetState: 'present', targetBytes: 3000, action: 'recheck', snapshotPath: `architecture/snapshots/${'c'.repeat(64)}.json`, snapshotPresent: false, new: counts, existing: { readable: true, valid: true, nodes: 3, edges: 2, evidence: 3 } } };
    }
    if (channel === 'architecture.save') return { ok: false, error: { code: 'PERMISSION_DENIED', message: 'The host could not write the model file.' } };
    throw new Error(`unexpected panel channel: ${channel}`);
  });
  const { elements, calls } = harness;

  elements.get('collect-form').dispatch('submit');
  await settle();
  elements.get('save-overwrite').dispatch('click');
  await settle();

  assert.equal(calls.filter((call) => call.channel === 'architecture.save').length, 2);
  assert.equal(elements.get('save-state').dataset.kind, 'error');
  assert.ok(containsText(elements.get('save-state'), 'PERMISSION_DENIED'));
  assert.ok(containsText(elements.get('save-results'), '未完成的保存'));
  // Nothing was written, so the collected model is still the active one and the
  // write buttons are withdrawn rather than left looking available.
  assert.equal(elements.get('model-source').textContent, '来自本次采集（未落盘）');
  assert.equal(elements.get('save-create').hidden, true);
  assert.equal(elements.get('save-overwrite').hidden, true);
});
test('panel draws a diagram, focuses a node through the index, and keeps the limits visible', async () => {
  const harness = createPanelHarness((channel, payload) => {
    if (channel === 'workspace.get') return { path: 'E:/work/demo' };
    if (channel === 'fs.stat') return { size: Buffer.byteLength(JSON.stringify(model), 'utf8') };
    if (channel === 'fs.readText') return JSON.stringify(model);
    if (channel === 'architecture.diagram') {
      // Focus is part of the request, so the stub answers with the state the
      // panel asked for instead of pretending one fixed diagram exists.
      const focused = typeof payload === 'object' && payload !== null && typeof payload.focus === 'string';
      return {
        ok: true,
        svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 656 390"><g class="dg-node" data-node-id="container.api" data-emphasis="on"><rect/></g><g class="dg-node" data-node-id="module.invoice" data-emphasis="off"><rect/></g></svg>',
        nodes: [{ id: 'container.api', name: 'API', type: 'container', status: 'confirmed', depth: 0 }, { id: 'module.invoice', name: 'Invoice', type: 'module', status: 'confirmed', depth: 1 }],
        edges: [{ id: 'edge.api.invoice', source: 'container.api', target: 'module.invoice', type: 'calls' }],
        focus: focused ? { id: 'container.api', name: 'API', neighbours: ['module.invoice'] } : null,
        truncated: false, omitted: { nodes: 0, edges: 0 },
        layout: { layers: 2, width: 656, height: 390, maxNodes: 150, maxEdges: 300 },
        limitations: ['确定性分层布局，不是运行态拓扑。'],
      };
    }
    throw new Error(`unexpected panel channel: ${channel}`);
  });
  const { elements, calls } = harness;
  elements.get('load-form').dispatch('submit');
  await settle();

  elements.get('diagram-draw').dispatch('click');
  await settle();
  const drawn = calls.at(-1);
  assert.equal(drawn.channel, 'architecture.diagram');
  assert.equal(drawn.payload.path, 'architecture/model.json');
  assert.equal(elements.get('diagram-status').dataset.kind, 'ready');
  assert.match(elements.get('diagram-surface').innerHTML, /data-node-id="container\.api"/);
  assert.ok(containsText(elements.get('diagram-results'), '确定性分层布局'));
  assert.equal(elements.get('diagram-clear').hidden, true, 'no focus was requested, so there is nothing to clear');

  // The index is the accessible path to the same focus the SVG carries.
  assert.equal(elements.get('diagram-index').children.length, 2);
  elements.get('diagram-index').children[0].dispatch('click');
  await settle();
  assert.equal(calls.at(-1).payload.focus, 'container.api');
  assert.equal(elements.get('diagram-clear').hidden, false);
  assert.ok(containsText(elements.get('diagram-results'), '焦点：API'));

  elements.get('diagram-clear').dispatch('click');
  await settle();
  assert.equal(calls.at(-1).payload.focus, undefined, 'clearing the focus must not send one');
  assert.equal(elements.get('diagram-clear').hidden, true);
});

test('panel pans and zooms the diagram as view state and never touches the model', async () => {
  const harness = createPanelHarness((channel, payload) => {
    if (channel === 'workspace.get') return { path: 'E:/work/demo' };
    if (channel === 'fs.stat') return { size: Buffer.byteLength(JSON.stringify(model), 'utf8') };
    if (channel === 'fs.readText') return JSON.stringify(model);
    if (channel === 'architecture.diagram') {
      const focused = typeof payload === 'object' && payload !== null && typeof payload.focus === 'string';
      return {
        ok: true,
        svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 656 390"><g class="dg-node" data-node-id="container.api" data-emphasis="on"><rect/></g><g class="dg-node" data-node-id="module.invoice" data-emphasis="off"><rect/></g></svg>',
        nodes: [{ id: 'container.api', name: 'API', type: 'container', status: 'confirmed', depth: 0 }, { id: 'module.invoice', name: 'Invoice', type: 'module', status: 'confirmed', depth: 1 }],
        edges: [{ id: 'edge.api.invoice', source: 'container.api', target: 'module.invoice', type: 'calls' }],
        focus: focused ? { id: 'container.api', name: 'API', neighbours: ['module.invoice'] } : null,
        truncated: false, omitted: { nodes: 0, edges: 0 },
        layout: { layers: 2, width: 656, height: 390, maxNodes: 150, maxEdges: 300 },
        limitations: ['确定性分层布局，不是运行态拓扑。'],
      };
    }
    throw new Error(`unexpected panel channel: ${channel}`);
  });
  const { elements, calls } = harness;
  const view = () => {
    const stage = elements.get('diagram-stage');
    return { scale: stage.attributes.get('data-diagram-scale'), x: stage.attributes.get('data-diagram-x'), y: stage.attributes.get('data-diagram-y'), panning: stage.attributes.get('data-diagram-panning') };
  };

  // The view controls describe a diagram, so they stay out of the way until one exists.
  assert.equal(elements.get('diagram-zoom-in').hidden, true);
  assert.equal(elements.get('diagram-zoom-out').hidden, true);
  assert.equal(elements.get('diagram-reset-view').hidden, true);
  elements.get('diagram-stage').dispatch('wheel', { deltaY: -120 });
  assert.equal(view().scale, '1', 'a wheel event with no diagram on screen must not move the view');

  elements.get('load-form').dispatch('submit');
  await settle();
  elements.get('diagram-draw').dispatch('click');
  await settle();
  assert.equal(elements.get('diagram-zoom-in').hidden, false, 'a drawn diagram offers the view controls');
  assert.equal(elements.get('diagram-reset-view').hidden, false);
  assert.deepEqual([view().scale, view().x, view().y], ['1', '0', '0']);

  elements.get('diagram-zoom-in').dispatch('click');
  assert.equal(view().scale, '1.25');
  elements.get('diagram-zoom-out').dispatch('click');
  assert.equal(view().scale, '1');
  for (let index = 0; index < 12; index += 1) elements.get('diagram-zoom-in').dispatch('click');
  assert.equal(view().scale, '4', 'zoom must stop at the upper clamp instead of running away');
  for (let index = 0; index < 20; index += 1) elements.get('diagram-zoom-out').dispatch('click');
  assert.equal(view().scale, '0.25', 'zoom must stop at the lower clamp');
  elements.get('diagram-reset-view').dispatch('click');
  assert.deepEqual([view().scale, view().x, view().y], ['1', '0', '0']);

  // A drag moves the canvas. Movement inside the slop does not, which is what
  // keeps a click on a node from being read as a pan. Each move is applied as a
  // delta, so a pointer that leaves and re-enters the stage cannot fling the
  // canvas by the distance it travelled outside.
  elements.get('diagram-stage').dispatch('pointerdown', { clientX: 100, clientY: 100 });
  assert.equal(view().panning, 'true', 'the stage must report that it is being dragged');
  elements.get('diagram-stage').dispatch('pointermove', { clientX: 101, clientY: 101 });
  assert.deepEqual([view().x, view().y], ['0', '0'], 'movement inside the slop must not count as a pan');
  elements.get('diagram-stage').dispatch('pointermove', { clientX: 130, clientY: 115 });
  elements.get('diagram-stage').dispatch('pointermove', { clientX: 160, clientY: 130 });
  assert.deepEqual([view().x, view().y], ['60', '30']);
  elements.get('diagram-stage').dispatch('pointerup', {});
  assert.equal(view().panning, 'false');

  // A pointer released outside the stage sends no pointerup, so the buttons
  // dropping to zero is what ends the drag instead of leaving it stuck on.
  elements.get('diagram-stage').dispatch('pointerdown', { clientX: 10, clientY: 10 });
  elements.get('diagram-stage').dispatch('pointermove', { clientX: 80, clientY: 40, buttons: 0 });
  assert.equal(view().panning, 'false', 'a move with no button held must end the drag');
  assert.deepEqual([view().x, view().y], ['60', '30'], 'ending a drag must not move the canvas');

  // A wheel event with no usable delta is ignored rather than read as zero.
  elements.get('diagram-stage').dispatch('wheel', { deltaY: undefined });
  assert.equal(view().scale, '1');

  // The view belongs to one drawing: redrawing for a new focus drops it.
  elements.get('diagram-index').children[0].dispatch('click');
  await settle();
  assert.equal(calls.at(-1).payload.focus, 'container.api');
  assert.deepEqual([view().scale, view().x, view().y], ['1', '0', '0'], 'a redraw must not inherit the previous offset');
  assert.equal(elements.get('diagram-zoom-in').hidden, false, 'the redrawn diagram keeps its view controls');
});

test('panel reports a change set as incomplete when a path matched nothing', async () => {
  const harness = createPanelHarness((channel) => {
    if (channel === 'workspace.get') return { path: 'E:/work/demo' };
    if (channel === 'fs.stat') return { size: Buffer.byteLength(JSON.stringify(model), 'utf8') };
    if (channel === 'fs.readText') return JSON.stringify(model);
    if (channel === 'architecture.impact') return {
      ok: true, sourceContentVerified: false,
      targets: [{ input: 'src/invoice/store.js', matchedNodeIds: ['container.api'] }],
      unresolvedTargets: [{ input: 'src/gone.js', reason: 'No stable node ID, stable file ID or declared evidence path matches this target.' }],
      changeSet: { requested: 2, resolved: 1, unresolved: 1, complete: false },
      impacted: [{ nodeId: 'datastore.billingdb', depth: 1, via: { edgeId: 'edge.api.db', fromNodeId: 'container.api', type: 'reads' }, status: 'confirmed', confidence: 'high', evidenceIds: [] }],
      stopReasons: [{ reason: 'frontier_exhausted', detail: 'traversal completed' }],
      truncated: false, dangling: [], stats: { visitedNodes: 1, visitedEdges: 1, maxDepthReached: 1, elapsedMs: 0 },
      modelContext: { coverage: model.coverage },
    };
    throw new Error(`unexpected panel channel: ${channel}`);
  });
  const { elements, calls } = harness;
  elements.get('load-form').dispatch('submit');
  await settle();

  elements.get('changeset-paths').value = 'src/invoice/store.js src/gone.js';
  elements.get('changeset-form').dispatch('submit');
  await settle();

  const sent = calls.at(-1);
  assert.equal(sent.channel, 'architecture.impact');
  assert.deepEqual([...sent.payload.targets], ['src/invoice/store.js', 'src/gone.js'], 'a pasted path list must not silently drop entries');
  assert.ok(containsText(elements.get('analysis-results'), '变更集汇总'));
  assert.ok(containsText(elements.get('analysis-results'), '未解析 1 个'));
  assert.ok(containsText(elements.get('analysis-results'), '结论完整：否'));
  assert.ok(containsText(elements.get('analysis-results'), 'src/gone.js'));
});

test('panel reports a drifted model and repeats the no-Git limit next to the verdict', async () => {
  const harness = createPanelHarness((channel) => {
    if (channel === 'workspace.get') return { path: 'E:/work/demo' };
    if (channel === 'fs.stat') return { size: Buffer.byteLength(JSON.stringify(model), 'utf8') };
    if (channel === 'fs.readText') return JSON.stringify(model);
    if (channel === 'architecture.drift') return {
      ok: true, verdict: 'drifted',
      findings: {
        missingEvidence: [{ evidenceId: 'ev.gone', path: 'src/gone.js', nodeIds: ['container.api'], edgeIds: [] }],
        noLongerModelled: [{ evidenceId: 'ev.dropped', path: 'src/dropped.js', nodeIds: [], edgeIds: [] }],
        unmodelledPaths: [{ path: 'src/new.js' }],
        existenceUnknown: [],
      },
      counts: { evidence: 4, missingEvidence: 1, noLongerModelled: 1, unmodelledPaths: 1, existenceUnknown: 0, enumerated: 9, modelled: 3 },
      truncated: false, omitted: { missingEvidence: 0, noLongerModelled: 0, unmodelledPaths: 0, existenceUnknown: 0 },
      limits: ['No Git state was read, so a file that still exists and is still cited may have changed without this check noticing.', 'No source file content was read; freshness is decided by path presence only.'],
      scan: { filesEnumerated: 9, filesModelled: 3, coverage: { complete: true }, diagnostics: [] },
    };
    throw new Error(`unexpected panel channel: ${channel}`);
  });
  const { elements, calls } = harness;
  elements.get('load-form').dispatch('submit');
  await settle();

  elements.get('drift-run').dispatch('click');
  await settle();
  assert.equal(calls.at(-1).channel, 'architecture.drift');
  assert.equal(calls.at(-1).payload.path, 'architecture/model.json');
  assert.equal(elements.get('drift-status').dataset.kind, 'ready');
  assert.ok(containsText(elements.get('drift-results'), '模型已偏离当前工作区'));
  assert.ok(containsText(elements.get('drift-results'), 'src/gone.js'));
  assert.ok(containsText(elements.get('drift-results'), '被 1 个节点 / 0 条边引用'));
  assert.ok(containsText(elements.get('drift-results'), 'No Git state was read'));
});
