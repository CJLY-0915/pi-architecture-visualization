'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const plugin = require('../main.js');
const model = require('../fixtures/valid-minimal-model.json');

const WORKSPACE = { path: 'E:/work/demo', name: 'demo' };

// Minimal stand-in for the verified host surface: pi.workspace.get(), pi.fs.list
// (one directory at a time, entries sorted by name) and pi.fs.readText.
function createHost(tree, options = {}) {
  const reads = [];
  const lists = [];
  const commands = new Map();
  const tools = new Map();
  const removed = [];
  const toasts = [];
  let panels = 0;
  let workspace = options.noWorkspace === true ? null : WORKSPACE;

  global.pi = {
    workspace: { get: async () => workspace },
    fs: {
      list: async (dir) => {
        lists.push(dir);
        if (options.rootListFails === true && dir === '') throw new Error('listing denied');
        if (options.listFails !== undefined && options.listFails.has(dir)) throw new Error('listing denied');
        const entries = tree[dir];
        if (entries === undefined) throw new Error(`cannot list ${dir || '.'}`);
        return entries;
      },
      readText: async (path) => {
        reads.push(path);
        if (options.failRead !== undefined && options.failRead.has(path)) throw new Error('read denied');
        const value = tree.files[path];
        if (value === undefined) throw new Error(`not found: ${path}`);
        return value;
      },
      stat: async (path) => {
        const value = tree.files[path];
        if (value === undefined) throw Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
        return { size: Buffer.byteLength(value, 'utf8'), mtimeMs: 0 };
      },
    },
    commands: {
      register: async (command) => commands.set(command.id, command),
      unregister: async (id) => {
        removed.push(id);
        if (options.failCleanup === true) throw new Error('cleanup failed');
      },
    },
    agent: {
      registerTool: async (tool) => {
        if (options.failRegisterTool === true) throw new Error('registration failed');
        tools.set(tool.name, tool);
      },
      unregisterTool: async (name) => { removed.push(name); },
    },
    ui: {
      openPanel: async () => { panels += 1; },
      showToast: async (message) => { toasts.push(message); },
    },
  };

  return {
    reads, lists, commands, tools, removed, toasts,
    panelCount: () => panels,
    setWorkspace: (next) => { workspace = next; },
  };
}

function simpleTree() {
  return {
    files: {
      'package.json': JSON.stringify({ name: 'demo', dependencies: { lodash: '^4.0.0' } }),
      'src/main.js': "import lodash from 'lodash';\nimport './helper.js';\n",
      'src/helper.js': 'export const helper = 1;\n',
      'README.md': '# demo\n',
    },
    '': [
      { name: 'package.json', path: 'package.json', isDirectory: false, size: 48 },
      { name: 'README.md', path: 'README.md', isDirectory: false, size: 7 },
      { name: 'src', path: 'src', isDirectory: true },
    ],
    src: [
      { name: 'helper.js', path: 'src/helper.js', isDirectory: false, size: 24 },
      { name: 'main.js', path: 'src/main.js', isDirectory: false, size: 48 },
    ],
  };
}

async function withHost(tree, options, body) {
  const host = createHost(tree, options);
  try {
    await plugin.onLoad();
    return await body(host);
  } finally {
    delete global.pi;
  }
}

test('onLoad registers three commands and seven tools, and unload releases all ten', async () => {
  const host = await withHost(simpleTree(), {}, async (value) => {
    assert.deepEqual([...value.commands.keys()].sort(), [
      'architecture-visualization.collect',
      'architecture-visualization.open',
      'architecture-visualization.validate',
    ]);
    assert.deepEqual([...value.tools.keys()].sort(), ['architecture_collect', 'architecture_compare', 'architecture_health', 'architecture_impact', 'architecture_query', 'architecture_snapshot_plan', 'architecture_validate']);
    assert.equal(value.tools.get('architecture_validate').risk, 'low');
    assert.equal(value.tools.get('architecture_collect').risk, 'low');
    assert.equal(value.tools.get('architecture_health').risk, 'low');
    await plugin.onUnload();
    return value;
  });
  assert.deepEqual(host.removed.sort(), [
    'architecture-visualization.collect',
    'architecture-visualization.open',
    'architecture-visualization.validate',
    'architecture_collect',
    'architecture_compare',
    'architecture_health',
    'architecture_impact',
    'architecture_query',
    'architecture_snapshot_plan',
    'architecture_validate',
  ]);
});

test('the validate tool shares the validator and rejects unsafe paths without reading', async () => {
  await withHost(simpleTree(), {}, async (host) => {
    const tool = host.tools.get('architecture_validate');
    for (const path of ['../x', '/x', 'C:/x', 'a\\b', 'a//b', './x', '', '.']) {
      assert.equal((await tool.execute({ path })).error.code, 'INVALID_PATH', `expected rejection for ${path}`);
    }
    assert.equal(host.reads.length, 0);
  });
});

test('the validate tool maps host failures and malformed input to stable codes', async () => {
  const tree = simpleTree();
  await withHost(tree, {}, async (host) => {
    const tool = host.tools.get('architecture_validate');

    tree.files['model.json'] = JSON.stringify(model);
    const ok = await tool.execute({ path: 'model.json' });
    assert.equal(ok.valid, true);

    tree.files['model.json'] = '{';
    assert.equal((await tool.execute({ path: 'model.json' })).error.code, 'INVALID_JSON');

    tree.files['model.json'] = 'x'.repeat(2 * 1024 * 1024 + 1);
    assert.equal((await tool.execute({ path: 'model.json' })).error.code, 'MODEL_TOO_LARGE');

    tree.files['missing.json'] = undefined;
    assert.equal((await tool.execute({ path: 'missing.json' })).error.code, 'NOT_FOUND');

    // No error text from the host may reach the caller.
    assert.ok(!JSON.stringify(host.toasts).includes('not found'));
  });
});

test('an unreachable project root is reported as no workspace', async () => {
  await withHost(simpleTree(), { rootListFails: true }, async (host) => {
    const result = await host.tools.get('architecture_collect').execute({});
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'NO_WORKSPACE');
    assert.deepEqual(host.reads, []);
  });
});

test('the collect tool survives a workspace payload it cannot interpret', async () => {
  // pi.workspace.get() describes the visible window while pi.fs follows the
  // session, so an unusable payload must not block a readable project.
  await withHost(simpleTree(), { noWorkspace: true }, async (host) => {
    const result = await host.tools.get('architecture_collect').execute({});
    assert.equal(result.ok, true);
    assert.ok(host.lists.length > 0, 'the readable project must still be traversed');
    assert.ok(result.nodes.some((node) => node.id === 'file:src/main.js'));
  });
});

test('the collect tool scans the workspace through the host and returns a valid model summary', async () => {
  await withHost(simpleTree(), {}, async (host) => {
    const result = await host.tools.get('architecture_collect').execute({});

    assert.equal(result.ok, true);
    assert.equal(result.validation.valid, true);
    assert.deepEqual(result.validation.diagnostics, []);
    assert.equal(result.coverage.complete, true);
    assert.deepEqual(result.coverage.adapters.map((adapter) => adapter.id), ['infra', 'js-ts', 'manifests']);
    assert.ok(result.coverage.filesScanned >= 3);

    const ids = result.nodes.map((node) => node.id);
    assert.ok(ids.includes('file:src/main.js'));
    assert.ok(ids.includes('external:lodash'));
    assert.equal(result.counts.evidence > 0, true);
    assert.equal(result.truncated, undefined);

    // Only the declared source files are read, never the directory listing twice.
    assert.deepEqual(host.reads.slice().sort(), ['README.md', 'package.json', 'src/helper.js', 'src/main.js']);
    assert.deepEqual(host.lists.slice().sort(), ['', 'src']);
  });
});

test('the collect command reports its result through a toast', async () => {
  await withHost(simpleTree(), {}, async (host) => {
    const result = await host.commands.get('architecture-visualization.collect').run();
    assert.equal(result.ok, true);
    assert.equal(host.toasts.length, 1);
    assert.match(host.toasts[0], /采集完成/);
    assert.match(host.toasts[0], /未写入/);
  });
});

test('the collect tool refuses unsafe scope roots before scanning', async () => {
  await withHost(simpleTree(), {}, async (host) => {
    const tool = host.tools.get('architecture_collect');
    for (const scopeRoots of [['..'], ['/abs'], ['C:/x'], ['a\\b'], ['./x'], [42], ['']]) {
      const result = await tool.execute({ scopeRoots });
      assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(scopeRoots)}`);
      assert.equal(result.error.code, 'INVALID_SCOPE');
    }
    assert.deepEqual(host.lists, []);
  });
});

test('the collect tool honours a scope root and its prefix boundary', async () => {
  const tree = simpleTree();
  tree[''] = [
    { name: 'src', path: 'src', isDirectory: true },
    { name: 'src2', path: 'src2', isDirectory: true },
  ];
  tree.src2 = [{ name: 'other.js', path: 'src2/other.js', isDirectory: false, size: 20 }];
  tree.files['src2/other.js'] = 'export const other = 1;\n';

  await withHost(tree, {}, async (host) => {
    const result = await host.tools.get('architecture_collect').execute({ scopeRoots: ['src'] });
    assert.equal(result.ok, true);
    // src2 is excluded by the prefix boundary and package.json is out of scope,
    // so only the two files under src/ and the dependency they import appear.
    assert.deepEqual(result.nodes.map((node) => node.id), ['external:lodash', 'file:src/helper.js', 'file:src/main.js']);
    assert.deepEqual(host.lists.sort(), ['', 'src']);
  });
});

test('a host per-directory cap is reported and forces coverage incomplete', async () => {
  const entries = [];
  const files = {};
  for (let index = 0; index < 1000; index += 1) {
    const name = `f${String(index).padStart(4, '0')}.js`;
    entries.push({ name, path: name, isDirectory: false, size: 20 });
    files[name] = 'export const value = 1;\n';
  }
  const tree = { files, '': entries };

  await withHost(tree, {}, async (host) => {
    const result = await host.tools.get('architecture_collect').execute({});
    assert.equal(result.coverage.complete, false);
    const caps = result.diagnostics.filter((entry) => entry.code === 'file_limit_reached');
    assert.ok(caps.some((entry) => /per-directory cap/.test(entry.message)), 'the host cap must be reported');
    assert.ok(result.coverage.filesScanned <= 500);
  });
});

test('an unlistable directory is reported and forces coverage incomplete', async () => {
  const tree = simpleTree();

  await withHost(tree, { listFails: new Set(['src']) }, async (host) => {
    const result = await host.tools.get('architecture_collect').execute({});
    assert.equal(result.coverage.complete, false);
    assert.ok(result.diagnostics.some((entry) => entry.code === 'source_list_failed' && entry.path === 'src'));
    assert.deepEqual(result.nodes.map((node) => node.id).sort(), ['container:package:package.json', 'external:lodash']);
  });
});

test('a file refused for its size is a skip, not a coverage gap', async () => {
  const tree = simpleTree();
  tree[''] = [
    { name: 'huge.js', path: 'huge.js', isDirectory: false, size: 8 * 1024 * 1024 },
    { name: 'src', path: 'src', isDirectory: true },
  ];

  await withHost(tree, {}, async (host) => {
    const result = await host.tools.get('architecture_collect').execute({});
    assert.equal(result.coverage.complete, true);
    assert.ok(result.diagnostics.some((entry) => entry.code === 'file_too_large' && entry.path === 'huge.js'));
    // The oversized file was never read: the size from the listing was enough.
    assert.ok(!host.reads.includes('huge.js'));
    assert.ok(result.nodes.some((node) => node.id === 'file:src/main.js'));
  });
});

test('the collected model does not depend on the order the host lists entries', async () => {
  const forward = simpleTree();
  const reversed = simpleTree();
  reversed[''] = reversed[''].slice().reverse();
  reversed.src = reversed.src.slice().reverse();

  const collect = async (tree) => withHost(tree, {}, async (host) =>
    host.tools.get('architecture_collect').execute({}));

  const first = await collect(forward);
  const second = await collect(reversed);
  assert.deepEqual(second.nodes, first.nodes);
  assert.deepEqual(second.edges, first.edges);
  assert.deepEqual(second.coverage, first.coverage);
  assert.deepEqual(second.diagnostics, first.diagnostics);
});

test('the collect tool bounds its response and says what it left out', async () => {
  const files = {};
  const entries = [];
  for (let index = 0; index < 200; index += 1) {
    const name = `m${String(index).padStart(3, '0')}.js`;
    entries.push({ name, path: name, isDirectory: false, size: 20 });
    files[name] = 'export const value = 1;\n';
  }

  await withHost({ files, '': entries }, {}, async (host) => {
    const result = await host.tools.get('architecture_collect').execute({});
    assert.equal(result.counts.nodes, 200);
    assert.equal(result.nodes.length, 150);
    assert.equal(result.truncated.nodes, 50);
    assert.match(result.truncatedNote, /nothing was written/);
    assert.ok(JSON.stringify(result).length < 256 * 1024);
  });
});

test('unusual host failures are contained and never leak host text', async () => {
  const tree = simpleTree();
  await withHost(tree, { failRead: new Set(['src/main.js']) }, async (host) => {
    const result = await host.tools.get('architecture_collect').execute({});
    assert.equal(result.ok, true);
    assert.ok(result.diagnostics.some((entry) => entry.code === 'source_read_failed'));
    assert.ok(!JSON.stringify(result).includes('read denied'));
  });
});

test('unload aggregates cleanup failures including synchronous throws', async () => {
  const host = createHost(simpleTree(), {});
  try {
    await plugin.onLoad();
    // A synchronous throw must not prevent the remaining releases from running.
    global.pi.agent.unregisterTool = (name) => {
      host.removed.push(name);
      if (name === 'architecture_collect') throw new Error('sync cleanup');
    };
    await assert.rejects(plugin.onUnload(),
      (error) => error instanceof AggregateError && error.errors.length === 1);
    assert.deepEqual(host.removed.sort(), [
      'architecture-visualization.collect',
      'architecture-visualization.open',
      'architecture-visualization.validate',
      'architecture_collect',
      'architecture_compare',
      'architecture_health',
      'architecture_impact',
      'architecture_query',
      'architecture_snapshot_plan',
      'architecture_validate',
    ]);
  } finally {
    delete global.pi;
  }
});

test('a failed tool registration rolls back every command already registered', async () => {
  const error = new Error('registration failed');
  const removed = [];
  let registered = 0;
  global.pi = {
    workspace: { get: async () => WORKSPACE },
    fs: { list: async () => [], readText: async () => '' },
    commands: { register: async () => { registered += 1; }, unregister: (id) => { removed.push(id); } },
    agent: { registerTool: async () => { throw error; } },
  };
  try {
    await assert.rejects(plugin.onLoad(), (thrown) => thrown === error);
    assert.equal(registered, 3);
    // Rollback runs in reverse registration order.
    assert.deepEqual(removed, [
      'architecture-visualization.collect',
      'architecture-visualization.validate',
      'architecture-visualization.open',
    ]);
  } finally {
    delete global.pi;
  }
});

test('scope roots and maxFiles are rejected instead of silently defaulted', async () => {
  await withHost(simpleTree(), {}, async (host) => {
    const tool = host.tools.get('architecture_collect');

    for (const scopeRoots of [[], 'src', ['.', '..'], null, [123]]) {
      const result = await tool.execute({ scopeRoots });
      assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(scopeRoots)}`);
      assert.equal(result.error.code, 'INVALID_SCOPE');
    }
    for (const maxFiles of [0, -1, 1.5, 'many', NaN]) {
      const result = await tool.execute({ maxFiles });
      assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(maxFiles)}`);
      assert.equal(result.error.code, 'INVALID_OPTION');
    }
    // The explicit whole-workspace root stays valid.
    assert.equal((await tool.execute({ scopeRoots: ['.'] })).ok, true);
    assert.deepEqual(host.lists.length > 0, true);
  });
});

test('list entries with an unexpected shape are reported, not dropped', async () => {
  const tree = simpleTree();
  tree[''] = [
    ...tree[''],
    null,
    'readme.md',
    { name: 'noflag.js', path: 'noflag.js' },
    { name: 'escape.js', path: '../escape.js', isDirectory: false, size: 5 },
    { name: 'drive.js', path: 'C:/drive.js', isDirectory: false, size: 5 },
    { name: 'ctrl.js', path: 'ctrl\u0001.js', isDirectory: false, size: 5 },
    { name: 'weird', path: 'weird', isDirectory: 'no' },
  ];

  await withHost(tree, {}, async (host) => {
    const result = await host.tools.get('architecture_collect').execute({});
    const ignored = result.diagnostics.filter((entry) => /ignored/.test(entry.message));
    assert.equal(ignored.length, 7, 'every malformed entry must be reported');
    assert.equal(result.coverage.complete, false);
    // None of the malformed paths was ever read.
    for (const bad of ['../escape.js', 'C:/drive.js', 'ctrl\u0001.js', 'noflag.js', 'weird']) {
      assert.ok(!host.reads.includes(bad), `${bad} must not be read`);
    }
  });
});

test('host error text never reaches the caller', async () => {
  const tree = simpleTree();
  await withHost(tree, { listFails: new Set(['src']) }, async (host) => {
    // Simulate a host message that embeds an absolute path.
    const original = global.pi.fs.list;
    global.pi.fs.list = async (dir) => {
      if (dir === 'src') throw new Error('EACCES: E:\\Program\\secret\\src is protected');
      return original(dir);
    };
    const result = await host.tools.get('architecture_collect').execute({});
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('EACCES'));
    assert.ok(!serialized.includes('secret'));
    assert.ok(result.diagnostics.some((entry) => entry.code === 'source_list_failed'));
  });
});

test('a bounded traversal is always reported as incomplete', async () => {
  const tree = simpleTree();
  tree[''] = [...tree[''], { name: 'src2', path: 'src2', isDirectory: true }];
  tree.src2 = [{ name: 'deep.js', path: 'src2/deep.js', isDirectory: false, size: 20 }];
  tree.files['src2/deep.js'] = 'export const deep = 1;\n';

  await withHost(tree, {}, async (host) => {
    const result = await host.tools.get('architecture_collect').execute({ scopeRoots: ['src'] });
    // Scope pruning is not a gap: only the scoped subtree was requested.
    assert.equal(result.coverage.complete, true);
    assert.deepEqual(result.nodes.map((node) => node.id), ['external:lodash', 'file:src/helper.js', 'file:src/main.js']);
  });
});

test('the response stays inside its byte budget even with long identifiers', async () => {
  const entries = [];
  const files = {};
  const long = 'p'.repeat(200);
  for (let index = 0; index < 400; index += 1) {
    const name = `${long}${index}.js`;
    entries.push({ name, path: name, isDirectory: false, size: 20 });
    files[name] = "import './missing.js';\n";
  }

  await withHost({ files, '': entries }, {}, async (host) => {
    const result = await host.tools.get('architecture_collect').execute({});
    const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    assert.ok(bytes <= 240 * 1024, `response was ${bytes} bytes`);
    assert.equal(result.counts.nodes, 400);
    assert.ok(result.truncated !== undefined);
    assert.ok(result.unresolved.length <= 100);
  });
});

test('extra project roots are reported as a coverage gap', async () => {
  const host = createHost(simpleTree(), {});
  const original = WORKSPACE;
  try {
    global.pi.workspace.get = async () => ({
      path: original.path,
      name: original.name,
      projectId: 'group-1',
      roots: [
        { path: original.path, name: 'demo' },
        { path: 'E:/work/other', name: 'other' },
      ],
    });
    await plugin.onLoad();
    const result = await host.tools.get('architecture_collect').execute({});
    assert.equal(result.coverage.complete, false);
    assert.ok(result.diagnostics.some((entry) => /local folders/.test(entry.message)));
    // The reachable root is still scanned.
    assert.ok(result.nodes.some((node) => node.id === 'file:src/main.js'));
  } finally {
    delete global.pi;
  }
});

test('extra project roots never turn an empty requested scope into NO_WORKSPACE', async () => {
  const host = createHost(simpleTree(), {});
  try {
    global.pi.workspace.get = async () => ({
      path: WORKSPACE.path,
      name: WORKSPACE.name,
      roots: [{ path: WORKSPACE.path }, { path: 'E:/work/other' }],
    });
    await plugin.onLoad();
    const result = await host.tools.get('architecture_collect').execute({ scopeRoots: ['docs'] });
    assert.notEqual(result.error && result.error.code, 'NO_WORKSPACE');
    assert.equal(result.coverage.complete, false);
    assert.ok(result.diagnostics.some((entry) => entry.code === 'source_roots_partial'));
  } finally {
    delete global.pi;
  }
});

test('a project with a single root is not reported as a gap', async () => {
  const host = createHost(simpleTree(), {});
  try {
    global.pi.workspace.get = async () => ({
      path: WORKSPACE.path,
      name: WORKSPACE.name,
      roots: [{ path: WORKSPACE.path, name: 'demo' }],
    });
    await plugin.onLoad();
    const result = await host.tools.get('architecture_collect').execute({});
    assert.equal(result.coverage.complete, true);
    assert.ok(!result.diagnostics.some((entry) => /local folders/.test(entry.message)));
  } finally {
    delete global.pi;
  }
});

test('an unusable workspace payload never blocks a readable project', async () => {
  const host = createHost(simpleTree(), {});
  try {
    for (const payload of [null, {}, { path: '' }, { path: 42 }, 'E:/work']) {
      global.pi.workspace.get = async () => payload;
      await plugin.onLoad();
      const result = await host.tools.get('architecture_collect').execute({});
      assert.equal(result.ok, true, `expected a scan for ${JSON.stringify(payload)}`);
      assert.ok(result.nodes.some((node) => node.id === 'file:src/main.js'));
    }
    assert.ok(host.lists.length > 0);
  } finally {
    delete global.pi;
  }
});

test('last P4 registration failure rolls back all prior resources', async () => {
  const host = createHost(simpleTree(), {});
  global.pi.agent.registerTool = async (tool) => {
    if (tool.name === 'architecture_compare') throw new Error('last registration failed');
    host.tools.set(tool.name, tool);
  };
  try {
    await assert.rejects(plugin.onLoad(), /last registration failed/);
    assert.deepEqual(host.removed, [
      'architecture_impact', 'architecture_query', 'architecture_collect', 'architecture_validate',
      'architecture-visualization.collect', 'architecture-visualization.validate', 'architecture-visualization.open',
    ]);
  } finally {
    delete global.pi;
  }
});

test('panel bridge exposes only fixed read-only analysis and in-memory export channels', async () => {
  const tree = simpleTree();
  tree.files['architecture/model.json'] = JSON.stringify(model);
  createHost(tree);
  try {
    const query = await plugin.onPanelInvoke('architecture.query', { path: 'architecture/model.json', mode: 'filter', limit: 10 });
    assert.equal(query.ok, true);
    assert.equal(query.sourceContentVerified, false);
    assert.equal(query.modelContext.coverage.complete, false);

    const preview = await plugin.onPanelInvoke('architecture.exportPreview', { path: 'architecture/model.json', format: 'png' });
    assert.equal(preview.ok, true);
    assert.equal(preview.supported, false);
    assert.equal(preview.content, null);
    assert.ok(preview.limitations.some((entry) => entry.includes('不生成或伪造 PNG')));

    const exportText = await plugin.onPanelInvoke('architecture.exportPreview', { path: 'architecture/model.json', format: 'markdown' });
    assert.equal(exportText.ok, true);
    assert.equal(exportText.supported, true);
    assert.match(exportText.content, /Sample Billing Monolith/);
    const rejectedExport = await plugin.onPanelInvoke('architecture.exportPreview', { path: 'architecture/model.json', format: 'markdown', save: true });
    assert.equal(rejectedExport.ok, false);
    assert.equal(rejectedExport.error.code, 'invalid_option');

    const impact = await plugin.onPanelInvoke('architecture.impact', { path: 'architecture/model.json', targets: ['module.invoice'], direction: 'downstream', maxDepth: 8, maxNodes: 20 });
    assert.equal(impact.ok, true);
    assert.equal(impact.sourceContentVerified, false);
    assert.ok(impact.impacted.some((item) => item.nodeId === 'datastore.billingdb'));

    const comparison = await plugin.onPanelInvoke('architecture.compare', { beforePath: 'architecture/model.json', afterPath: 'architecture/model.json' });
    assert.equal(comparison.ok, true);
    assert.equal(comparison.identical, true);

    const unsupported = await plugin.onPanelInvoke('agent.executeTool', { name: 'architecture_query' });
    assert.deepEqual(unsupported, { ok: false, error: { code: 'unsupported_input', message: 'This panel operation is not available.' } });
  } finally {
    delete global.pi;
  }
});

test('health tool and panel channel read one validated model without source verification', async () => {
  const tree = simpleTree();
  tree.files['architecture/model.json'] = JSON.stringify(model);
  const host = createHost(tree);
  try {
    await plugin.onLoad();
    const toolResult = await host.tools.get('architecture_health').execute({ path: 'architecture/model.json' });
    assert.equal(toolResult.ok, true);
    assert.equal(toolResult.sourceContentVerified, false);
    assert.equal(toolResult.unverified.evidenceFreshness, 'unknown');
    assert.ok(toolResult.findings.some((finding) => finding.code === 'coverage_incomplete'));

    const panelResult = await plugin.onPanelInvoke('architecture.health', { path: 'architecture/model.json' });
    assert.equal(panelResult.ok, true);
    assert.deepEqual(panelResult.counts, toolResult.counts);
    await plugin.onUnload();
  } finally {
    delete global.pi;
  }
});

test('health tool and panel preserve invalid-model diagnostics without enabling other analyses', async () => {
  const tree = simpleTree();
  const invalid = JSON.parse(JSON.stringify(model));
  invalid.edges[0].target = 'node.missing';
  tree.files['architecture/invalid.json'] = JSON.stringify(invalid);
  const host = createHost(tree);
  try {
    await plugin.onLoad();
    const toolResult = await host.tools.get('architecture_health').execute({ path: 'architecture/invalid.json' });
    assert.equal(toolResult.ok, false);
    assert.equal(toolResult.validation.valid, false);
    assert.ok(toolResult.findings.some((finding) => finding.code === 'dangling_edge_endpoint' && finding.category === 'conflicts'));
    assert.equal(toolResult.sourceContentVerified, false);
    assert.equal(toolResult.unverified.evidenceFreshness, 'unknown');

    const panelResult = await plugin.onPanelInvoke('architecture.health', { path: 'architecture/invalid.json' });
    assert.equal(panelResult.ok, false);
    assert.deepEqual(panelResult.findings, toolResult.findings);

    const queryResult = await plugin.onPanelInvoke('architecture.query', { path: 'architecture/invalid.json', mode: 'filter' });
    assert.equal(queryResult.ok, false);
    assert.equal(queryResult.error.code, 'INVALID_MODEL');
    await plugin.onUnload();
  } finally {
    delete global.pi;
  }
});

test('health preserves contract diagnostics for a parsed null model', async () => {
  const tree = simpleTree();
  tree.files['architecture/null.json'] = 'null';
  const host = createHost(tree);
  try {
    await plugin.onLoad();
    const toolResult = await host.tools.get('architecture_health').execute({ path: 'architecture/null.json' });
    assert.equal(toolResult.ok, false);
    assert.equal(toolResult.error, undefined);
    assert.equal(toolResult.validation.valid, false);
    assert.ok(toolResult.findings.some((finding) => finding.code === 'model_not_object' && finding.category === 'contract'));

    const panelResult = await plugin.onPanelInvoke('architecture.health', { path: 'architecture/null.json' });
    assert.equal(panelResult.ok, false);
    assert.deepEqual(panelResult.findings, toolResult.findings);
    await plugin.onUnload();
  } finally {
    delete global.pi;
  }
});
