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
  dispatch(type) {
    const listener = this.listeners.get(type);
    assert.ok(listener, `${this.id || 'element'} must handle ${type}`);
    return listener({ preventDefault() {} });
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
    querySelectorAll(selector) { assert.equal(selector, '.analysis-form input, .analysis-form select, .analysis-form button'); return ['query-mode', 'query-targets', 'query-to', 'impact-targets', 'impact-direction', 'compare-before', 'compare-after', 'export-format', 'query-form', 'impact-form', 'compare-form', 'export-form', 'health-form'].map((id) => elements.get(id)); },
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
  assert.ok(containsText(elements.get('collect-results'), '没有写入磁盘'));
  assert.ok(containsText(elements.get('collect-results'), '仅显示前 24') === false);

  // A non-positive file budget is refused locally instead of being guessed.
  elements.get('collect-max').value = '0';
  elements.get('collect-form').dispatch('submit');
  await settle();
  assert.equal(calls.length, 1, 'an invalid file budget must not reach the bridge');
  assert.equal(elements.get('collect-status').dataset.kind, 'error');
  assert.ok(containsText(elements.get('collect-status'), '正整数'));
});
