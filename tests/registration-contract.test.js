'use strict';

// The manifest declares commands, agent tools and activation events; main.js
// registers and releases them. These tests keep the two in step, so a manifest
// addition cannot ship unregistered and a code registration cannot stay
// undeclared. The existing host-adapter tests pin the exact sets by hand; this
// file derives them from the manifest instead, which is what catches drift.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const plugin = require('../main.js');
const manifest = require('../manifest.json');
const model = require('../fixtures/valid-minimal-model.json');

const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');

function createHost(files) {
  const commands = new Map();
  const tools = new Map();
  const removed = [];
  global.pi = {
    workspace: { get: async () => ({ path: 'E:/work/demo', name: 'demo' }) },
    fs: {
      list: async () => [],
      readText: async (filePath) => {
        const value = files[filePath];
        if (value === undefined) throw Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
        return value;
      },
      stat: async (filePath) => {
        const value = files[filePath];
        if (value === undefined) throw Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
        return { size: Buffer.byteLength(value, 'utf8'), mtimeMs: 0 };
      },
    },
    commands: {
      register: async (command) => commands.set(command.id, command),
      unregister: async (id) => removed.push(id),
    },
    agent: {
      registerTool: async (tool) => tools.set(tool.name, tool),
      unregisterTool: async (name) => removed.push(name),
    },
    ui: { openPanel: async () => {}, showToast: async () => {} },
  };
  return { commands, tools, removed };
}

async function loadPlugin(files = {}) {
  const host = createHost(files);
  await plugin.onLoad();
  return host;
}

test('onLoad registers exactly the commands and tools the manifest declares', async () => {
  const host = await loadPlugin();
  try {
    assert.deepEqual([...host.commands.keys()].sort(), manifest.contributes.commands.map((c) => c.id).sort());
    assert.deepEqual([...host.tools.keys()].sort(), manifest.contributes.agentTools.map((t) => t.name).sort());
  } finally {
    delete global.pi;
  }
});

test('registered tool declarations are the manifest declarations', async () => {
  const host = await loadPlugin();
  try {
    for (const declared of manifest.contributes.agentTools) {
      const registered = host.tools.get(declared.name);
      assert.ok(registered, `missing registration for ${declared.name}`);
      assert.equal(registered.description, declared.description, `${declared.name} description drifted`);
      assert.equal(registered.risk, declared.risk, `${declared.name} risk drifted`);
      assert.deepEqual(registered.schema, declared.schema, `${declared.name} schema drifted`);
      assert.equal(typeof registered.execute, 'function', `${declared.name} needs an execute function`);
    }
  } finally {
    delete global.pi;
  }
});

test('onUnload releases every command and tool that was registered', async () => {
  const host = await loadPlugin();
  try {
    await plugin.onUnload();
    assert.deepEqual(host.removed.sort(), [
      ...manifest.contributes.commands.map((c) => c.id),
      ...manifest.contributes.agentTools.map((t) => t.name),
    ].sort());
  } finally {
    delete global.pi;
  }
});

test('every declared command has an activation event and vice versa', () => {
  const declared = manifest.contributes.commands.map((c) => `onCommand:${c.id}`).sort();
  const events = manifest.activationEvents.slice().sort();
  assert.deepEqual(events, declared, 'activationEvents must mirror contributes.commands exactly');
});

test('the panel invokes only whitelisted channels, and every whitelisted channel is used', () => {
  const used = [...new Set([...RENDERER.matchAll(/architecture\.[a-zA-Z]+/g)].map((match) => match[0]))].sort();
  const whitelisted = Object.keys(plugin.PANEL_ANALYSIS_CHANNELS).sort();
  assert.ok(used.length > 0, 'the panel should call at least one architecture channel');
  assert.deepEqual(used, whitelisted, 'panel channels and the main.js whitelist must match in both directions');
});

test('an unwhitelisted panel channel is refused instead of executed', async () => {
  const files = { 'architecture/model.json': JSON.stringify(model) };
  const host = createHost(files);
  try {
    for (const channel of ['architecture.save', 'architecture.export', 'fs.write', 'ui.openPanel']) {
      const result = await plugin.onPanelInvoke(channel, { path: 'architecture/model.json' });
      assert.equal(result.ok, false, `${channel} must not be available`);
      assert.equal(result.error.code, 'unsupported_input', `${channel} must be refused as unsupported`);
    }
    assert.equal(host.tools.size, 0, 'refusing a channel must not register anything');
  } finally {
    delete global.pi;
  }
});

test('every whitelisted panel channel reaches a handler', async () => {
  const files = { 'architecture/model.json': JSON.stringify(model) };
  await loadPlugin(files);
  try {
    for (const channel of Object.keys(plugin.PANEL_ANALYSIS_CHANNELS)) {
      const result = await plugin.onPanelInvoke(channel, { path: 'architecture/model.json' });
      // `architecture.exportPreview` and `architecture.health` are implemented
      // inside onPanelInvoke rather than as agent tools, and impact/compare
      // legitimately fail without explicit targets. What matters is that the
      // whitelist routed the call to a handler instead of refusing the channel.
      assert.notEqual(result.error && result.error.code, 'unsupported_input', `${channel} must be handled`);
    }
    const impact = await plugin.onPanelInvoke('architecture.impact', { path: 'architecture/model.json' });
    assert.equal(impact.error.code, 'change_source_unavailable', 'impact must reach its handler and demand explicit targets');
  } finally {
    delete global.pi;
  }
});
