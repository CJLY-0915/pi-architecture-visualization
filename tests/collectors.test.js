'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { collectModel, ADAPTER_IDS } = require('../src/collectors');
const { validateModel } = require('../src/core/validation');
const { CODES, isKnownCode } = require('../src/core/error-codes');

const ROOT_DIR = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT_DIR, 'fixtures', 'synthetic-project');
const BASE_OPTIONS = Object.freeze({ projectId: 'test-project', generatedAt: '2024-05-01T09:30:00Z' });
const MODEL_COLLECTIONS = Object.freeze([
  'nodes', 'edges', 'evidence', 'views', 'findings', 'decisions', 'migrationSlices', 'unknowns',
]);

function listFixturePaths(dir, prefix = '') {
  const paths = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : 1))) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) paths.push(...listFixturePaths(path.join(dir, entry.name), relative));
    else paths.push(relative);
  }
  return paths;
}

function fixtureEntries() {
  const entries = {};
  for (const relative of listFixturePaths(FIXTURE_DIR)) {
    entries[relative] = fs.readFileSync(path.join(FIXTURE_DIR, relative), 'utf8');
  }
  return entries;
}

// In-memory stand-in for the host file source. `reads` records every path the
// collector actually asked for, which is how the tests prove that unsafe and
// sensitive paths are never touched.
function memorySource(entries, options = {}) {
  const reads = [];
  return {
    reads,
    listFiles: async () => {
      if (options.listFails) throw new Error('listFiles failed');
      const paths = Object.keys(entries);
      return options.order === undefined ? paths : options.order(paths);
    },
    readText: async (filePath) => {
      reads.push(filePath);
      if (options.failRead !== undefined && options.failRead.has(filePath)) throw new Error('readText failed');
      if (!Object.prototype.hasOwnProperty.call(entries, filePath)) throw new Error(`not listed: ${filePath}`);
      return entries[filePath];
    },
  };
}

async function collect(entries, options = {}, sourceOptions = {}) {
  const source = memorySource(entries, sourceOptions);
  const result = await collectModel({ source, options: Object.assign({}, BASE_OPTIONS, options) });
  return { result, source };
}

function codesOf(entries, code) {
  return entries.filter((entry) => entry.code === code);
}

function sortedIds(items) {
  return items.map((item) => item.id).sort();
}

test('the synthetic project produces a valid, evidence-backed model', async () => {
  const { result } = await collect(fixtureEntries());

  assert.equal(result.ok, true);
  assert.equal(result.validation.valid, true);
  assert.deepEqual(result.validation.diagnostics, []);
  assert.deepEqual(result.diagnostics, []);

  const nodeIds = sortedIds(result.model.nodes);
  for (const expected of [
    'file:src/main.js',
    'file:src/invoke.js',
    'file:src/store.ts',
    'file:src/legacy.cjs',
    'external:left-pad',
    'external:not-declared-pkg',
    'container:package:package.json',
    'container:compose-service:docker-compose.yml#api',
    'container:compose-service:docker-compose.yml#db',
  ]) {
    assert.ok(nodeIds.includes(expected), `missing node ${expected}`);
  }

  // A declared dependency is confirmed by its manifest, an undeclared bare
  // import stays inferred and carries no evidence.
  const declared = result.model.nodes.find((node) => node.id === 'external:left-pad');
  assert.equal(declared.status, 'confirmed');
  assert.ok(declared.evidenceIds.length > 0);
  const undeclared = result.model.nodes.find((node) => node.id === 'external:not-declared-pkg');
  assert.equal(undeclared.status, 'inferred');
  assert.equal(undeclared.confidence, 'low');
  assert.deepEqual(undeclared.evidenceIds, []);

  assert.ok(result.model.edges.some((edge) => edge.source === 'file:src/main.js' && edge.target === 'external:left-pad'));
  assert.ok(result.model.edges.some((edge) => edge.source === 'file:src/main.js' && edge.target === 'file:src/store.ts'));

  // Every confirmed claim resolves to declared evidence, and every node is a
  // current-state observation because adapters never set `state`.
  const declaredEvidence = new Set(result.model.evidence.map((entry) => entry.id));
  for (const item of [...result.model.nodes, ...result.model.edges]) {
    assert.equal(item.state, 'current', `${item.id} must be a current-state observation`);
    if (item.status !== 'confirmed') continue;
    assert.ok(item.evidenceIds.length > 0, `${item.id} is confirmed without evidence`);
    for (const id of item.evidenceIds) {
      assert.ok(declaredEvidence.has(id), `${item.id} references undeclared evidence ${id}`);
    }
  }
});

test('the model keeps every v1 collection and reports every adapter', async () => {
  const { result } = await collect(fixtureEntries());

  for (const name of MODEL_COLLECTIONS) assert.ok(Array.isArray(result.model[name]), `${name} must be an array`);
  assert.deepEqual(result.model.views, []);
  assert.deepEqual(result.model.findings, []);
  assert.deepEqual(result.model.decisions, []);
  assert.deepEqual(result.model.migrationSlices, []);
  assert.deepEqual(result.model.unknowns, []);

  assert.equal(result.model.schemaVersion, 1);
  assert.equal(result.model.project.id, BASE_OPTIONS.projectId);
  assert.equal(result.model.generatedAt, BASE_OPTIONS.generatedAt);
  assert.equal(result.model.sourceRevision, null);
  assert.deepEqual(result.model.scope.roots, ['.']);

  assert.deepEqual(ADAPTER_IDS, ['js-ts', 'manifests', 'infra']);
  assert.deepEqual(result.coverage.adapters.map((adapter) => adapter.id), ['infra', 'js-ts', 'manifests']);
  for (const adapter of result.coverage.adapters) {
    assert.equal(typeof adapter.matched, 'number');
    assert.equal(typeof adapter.limited, 'boolean');
  }
  assert.ok(result.coverage.adapters.every((adapter) => adapter.matched > 0));
});

test('coverage accounts for every listed file', async () => {
  const { result } = await collect(fixtureEntries());

  assert.equal(result.coverage.complete, true);
  assert.equal(result.model.coverage.complete, true);
  assert.equal(result.model.coverage.filesScanned, result.coverage.filesScanned);
  assert.equal(result.coverage.filesListed, result.coverage.filesScanned + result.coverage.filesSkipped);

  // Nothing in the committed fixture is skipped, so every listed file was read.
  assert.equal(result.coverage.filesSkipped, 0);
  assert.deepEqual(codesOf(result.unresolved, CODES.SENSITIVE_PATH_SKIPPED), []);
});

test('the model keeps the coverage ledger so a saved file shows what was withheld', async () => {
  // filesListed and filesSkipped are reported on the result; unless they are
  // written into the model too, the only artifact a consumer can read loses the
  // fact that files were listed and never read.
  const { result } = await collect({
    'src/a.js': 'export const a = 1;\n',
    'src/big.js': `export const big = '${'x'.repeat(200)}';\n`,
  }, { maxFileChars: 50 });

  assert.equal(result.coverage.filesListed, 2);
  assert.equal(result.coverage.filesScanned, 1);
  assert.equal(result.coverage.filesSkipped, 1);
  assert.equal(result.model.coverage.filesListed, 2);
  assert.equal(result.model.coverage.filesScanned, 1);
  assert.equal(result.model.coverage.filesSkipped, 1);
  assert.equal(result.validation.valid, true);
});

test('policy-ignored files are counted in filesListed only', async () => {
  // `dist/` and `.png` are ignored by policy rather than withheld from a scan:
  // they never become candidates, so filesSkipped does not include them and the
  // listed/scanned/skipped identity holds only when nothing was ignored.
  const { result } = await collect({
    'dist/bundle.js': 'export const built = 1;\n',
    'assets/logo.png': 'not really a png',
    'src/a.js': 'export const a = 1;\n',
  });

  assert.equal(result.coverage.filesListed, 3);
  assert.equal(result.coverage.filesScanned, 1);
  assert.equal(result.coverage.filesSkipped, 0);
  assert.equal(result.model.coverage.filesListed, 3);
  assert.equal(result.model.coverage.filesSkipped, 0);
  assert.equal(result.coverage.complete, true);
});

test('the committed fixture tree contains no credential-shaped path', async () => {
  // The host packager refuses to ship credential files, so a fixture that looks
  // like one would be missing from the installed plugin while the tests still
  // expected it. Sensitive-path skipping is covered by an in-memory test instead.
  const paths = Object.keys(fixtureEntries());
  assert.deepEqual(paths.filter((entry) => /(^|\/)\.env|\.pem$|\.key$|\.p12$|\.pfx$|secrets|credentials|id_rsa/.test(entry)), []);
  const { result } = await collect(fixtureEntries());
  assert.deepEqual(codesOf(result.unresolved, CODES.SENSITIVE_PATH_SKIPPED), []);
});

test('the same source produces the same result regardless of listing order', async () => {
  const entries = fixtureEntries();
  const first = (await collect(entries)).result;
  const second = (await collect(entries)).result;
  assert.deepEqual(second, first);

  const reversed = (await collect(entries, {}, { order: (paths) => paths.slice().reverse() })).result;
  assert.deepEqual(reversed.model, first.model);
  assert.deepEqual(reversed.coverage, first.coverage);
  assert.deepEqual(reversed.unresolved, first.unresolved);
  assert.deepEqual(reversed.diagnostics, first.diagnostics);
  assert.equal(reversed.ok, first.ok);
});

test('module ids, evidence and collections are sorted deterministically', async () => {
  const { result } = await collect(fixtureEntries());

  for (const name of ['nodes', 'edges', 'evidence']) {
    assert.deepEqual(result.model[name].map((item) => item.id), sortedIds(result.model[name]), `${name} must be sorted by id`);
  }
  for (const list of [result.unresolved, result.diagnostics]) {
    const keys = list.map((entry) => `${entry.path}\u0000${entry.code}\u0000${entry.message}`);
    assert.deepEqual(keys, keys.slice().sort());
  }
  assert.equal(new Set(result.model.nodes.map((node) => node.id)).size, result.model.nodes.length);
  assert.equal(new Set(result.model.edges.map((edge) => edge.id)).size, result.model.edges.length);
  assert.equal(new Set(result.model.evidence.map((entry) => entry.id)).size, result.model.evidence.length);
});

test('dynamic and non-literal module calls are reported instead of guessed', async () => {
  const { result } = await collect(fixtureEntries());

  const unsupported = codesOf(result.unresolved, CODES.UNSUPPORTED_INPUT);
  assert.ok(unsupported.some((entry) => entry.path === 'src/main.js' && /dynamic import/.test(entry.message)));
  assert.ok(unsupported.some((entry) => entry.path === 'src/legacy.cjs' && /non-literal/.test(entry.message)));
  assert.ok(unsupported.some((entry) => entry.path === '.github/workflows/ci.yml'));

  // Neither construct produced a dependency edge: the dynamic import and the
  // non-literal require are absent from the target set.
  assert.deepEqual(result.model.edges.filter((edge) => edge.source === 'file:src/legacy.cjs'), []);
  assert.deepEqual(
    result.model.edges.filter((edge) => edge.source === 'file:src/main.js').map((edge) => edge.target).sort(),
    ['external:left-pad', 'external:missing-local', 'external:not-declared-pkg', 'file:src/invoke.js', 'file:src/store.ts'],
  );
});

test('a relative specifier that resolves to nothing is unresolved and creates no edge', async () => {
  const { result } = await collect({
    'src/a.js': "import './gone.js';\nexport const a = 1;\n",
    'src/b.js': 'export const b = 1;\n',
  });

  assert.equal(result.ok, true);
  assert.equal(result.validation.valid, true);
  assert.deepEqual(codesOf(result.unresolved, CODES.UNRESOLVED_REFERENCE).map((entry) => entry.path), ['src/a.js']);
  assert.deepEqual(result.model.edges, []);
  assert.deepEqual(sortedIds(result.model.nodes), ['file:src/a.js', 'file:src/b.js']);
});

test('a declared dependency and its import merge into one confirmed node', async () => {
  const { result } = await collect({
    'package.json': JSON.stringify({ name: 'app', dependencies: { leftpad: '^1.0.0' } }),
    'src/main.js': "import leftpad from 'leftpad';\n",
  });

  assert.equal(result.validation.valid, true);
  const nodes = result.model.nodes.filter((node) => node.id === 'external:leftpad');
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].status, 'confirmed');
  // The manifest evidence id is identical for both adapters, so the merge
  // deduplicates it instead of declaring it twice.
  assert.deepEqual(nodes[0].evidenceIds, ['ev:package.json#0:config']);
  assert.equal(result.model.nodes.filter((node) => node.id === 'container:package:package.json').length, 1);
});

test('compose services become containers and depends_on becomes an edge', async () => {
  const { result } = await collect(fixtureEntries());

  const services = result.model.nodes
    .filter((node) => node.id.startsWith('container:compose-service:'))
    .map((node) => node.id);
  assert.deepEqual(services, [
    'container:compose-service:docker-compose.yml#api',
    'container:compose-service:docker-compose.yml#db',
  ]);

  const edges = result.model.edges.filter((edge) => edge.source.startsWith('container:compose-service:'));
  assert.equal(edges.length, 1);
  assert.equal(edges[0].target, 'container:compose-service:docker-compose.yml#db');
  assert.equal(edges[0].status, 'confirmed');
});

test('config types that are not modelled are indexed instead of faked', async () => {
  const { result } = await collect({
    '.github/workflows/ci.yml': 'name: ci\non: push\njobs: {}\n',
    'openapi.yaml': 'openapi: 3.0.0\ninfo:\n  title: t\n',
    'infra/main.tf': 'resource "null_resource" "x" {}\n',
  });

  assert.equal(result.validation.valid, true);
  assert.deepEqual(result.model.nodes, []);
  assert.deepEqual(result.model.edges, []);
  assert.deepEqual(
    codesOf(result.unresolved, CODES.UNSUPPORTED_INPUT).map((entry) => entry.path),
    ['.github/workflows/ci.yml', 'infra/main.tf', 'openapi.yaml'],
  );
});
test('Maven and Gradle build files are reported instead of silently ignored', async () => {
  const { result } = await collect({
    'pom.xml': '<project><artifactId>app</artifactId></project>\n',
    'build.gradle': "apply plugin: 'java'\n",
    'settings.gradle.kts': 'rootProject.name = "app"\n',
    'src/app.js': 'export const value = 1;\n',
  });

  assert.equal(result.validation.valid, true);
  assert.deepEqual(result.model.nodes.map((node) => node.id), ['file:src/app.js']);
  assert.deepEqual(result.model.edges, []);

  const javaBuilds = codesOf(result.unresolved, CODES.UNSUPPORTED_INPUT);
  assert.deepEqual(javaBuilds.map((entry) => entry.path), ['build.gradle', 'pom.xml', 'settings.gradle.kts']);
  assert.ok(javaBuilds.every((entry) => /Maven|Gradle/.test(entry.message)));
});

test('reaching maxFiles truncates deterministically and marks coverage incomplete', async () => {
  const entries = {};
  for (let index = 0; index < 5; index += 1) entries[`src/f${index}.js`] = 'export const v = 1;\n';

  const { result, source } = await collect(entries, { maxFiles: 2 });

  assert.equal(result.ok, true);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.model.coverage.complete, false);
  assert.equal(result.validation.valid, true);
  assert.equal(codesOf(result.diagnostics, CODES.FILE_LIMIT_REACHED).length, 1);
  assert.deepEqual(source.reads, ['src/f0.js', 'src/f1.js']);
  assert.equal(result.coverage.adapters.find((adapter) => adapter.id === 'js-ts').limited, true);
});

test('a file over maxFileChars is skipped while the rest is still analysed', async () => {
  const { result } = await collect({
    'src/big.js': `export const big = '${'x'.repeat(200)}';\n`,
    'src/small.js': 'export const small = 1;\n',
  }, { maxFileChars: 50 });

  assert.equal(result.ok, true);
  assert.equal(result.validation.valid, true);
  assert.equal(result.coverage.complete, true);
  assert.deepEqual(codesOf(result.diagnostics, CODES.FILE_TOO_LARGE).map((entry) => entry.path), ['src/big.js']);
  assert.deepEqual(sortedIds(result.model.nodes), ['file:src/small.js']);
});

test('exceeding the timeout budget stops the scan and marks coverage incomplete', async () => {
  const entries = { 'src/a.js': 'export const a = 1;\n', 'src/b.js': 'export const b = 1;\n' };
  let clock = 0;

  const { result } = await collect(entries, { timeoutMs: 10, now: () => (clock += 100) });

  assert.equal(result.coverage.complete, false);
  assert.equal(result.validation.valid, true);
  assert.equal(codesOf(result.diagnostics, CODES.COLLECTION_TIMEOUT).length, 1);
  assert.deepEqual(result.model.nodes, []);
});

test('sensitive paths are reported and never read', async () => {
  const entries = {
    '.env.example': 'A=1\n',
    '.env.local': 'B=2\n',
    '.ssh/id_rsa': 'key\n',
    'deploy/server.pem': 'cert\n',
    'secrets.json': '{}\n',
    'src/app.js': 'export const app = 1;\n',
  };

  const { result, source } = await collect(entries);

  assert.deepEqual(
    codesOf(result.unresolved, CODES.SENSITIVE_PATH_SKIPPED).map((entry) => entry.path),
    ['.env.example', '.env.local', '.ssh/id_rsa', 'deploy/server.pem', 'secrets.json'],
  );
  assert.deepEqual(source.reads, ['src/app.js']);
  assert.equal(result.coverage.filesSkipped, 5);
  assert.equal(result.validation.valid, true);
});

test('unsafe paths are reported and never read', async () => {
  const entries = {
    '../outside.js': 'export const outside = 1;\n',
    './relative.js': 'export const relative = 1;\n',
    '/absolute.js': 'export const absolute = 1;\n',
    'C:/drive.js': 'export const drive = 1;\n',
    'back\\slash.js': 'export const backslash = 1;\n',
    'empty//segment.js': 'export const empty = 1;\n',
    'src/app.js': 'export const app = 1;\n',
  };

  const { result, source } = await collect(entries);

  assert.deepEqual(
    codesOf(result.unresolved, CODES.UNSAFE_PATH_SKIPPED).map((entry) => entry.path),
    ['../outside.js', './relative.js', '/absolute.js', 'C:/drive.js', 'back\\slash.js', 'empty//segment.js'],
  );
  assert.deepEqual(source.reads, ['src/app.js']);
  assert.equal(result.coverage.filesListed, 7);
  assert.equal(result.validation.valid, true);
});

test('non-string and duplicate listed entries are handled without reading them', async () => {
  const entries = { 'src/app.js': 'export const app = 1;\n' };
  const source = {
    reads: [],
    listFiles: async () => [42, null, 'src/app.js', 'src/app.js'],
    readText: async (filePath) => {
      source.reads.push(filePath);
      return entries[filePath];
    },
  };

  const result = await collectModel({ source, options: BASE_OPTIONS });

  assert.deepEqual(source.reads, ['src/app.js']);
  assert.equal(codesOf(result.unresolved, CODES.UNSAFE_PATH_SKIPPED).length, 2);
  assert.equal(result.validation.valid, true);
  assert.deepEqual(sortedIds(result.model.nodes), ['file:src/app.js']);
});

test('non-source files are listed but produce no nodes', async () => {
  const { result, source } = await collect({
    'README.md': '# Synthetic\n',
    'assets/logo.png': 'not really a png',
    'src/app.js': 'export const app = 1;\n',
  });

  assert.equal(result.coverage.filesListed, 3);
  assert.deepEqual(source.reads, ['README.md', 'src/app.js']);
  assert.deepEqual(sortedIds(result.model.nodes), ['file:src/app.js']);
  assert.equal(result.validation.valid, true);
});

test('a failing source is reported without throwing and still yields a valid model', async () => {
  const { result } = await collect({}, {}, { listFails: true });

  assert.equal(result.ok, false);
  assert.equal(result.validation.valid, true);
  assert.deepEqual(codesOf(result.diagnostics, CODES.SOURCE_LIST_FAILED).map((entry) => entry.path), ['']);
  assert.deepEqual(result.model.nodes, []);
  assert.deepEqual(result.model.edges, []);
  assert.equal(result.coverage.filesListed, 0);
  // Nothing was scanned, so coverage must not claim completeness.
  assert.equal(result.coverage.complete, false);
  assert.equal(result.model.coverage.complete, false);
  assert.deepEqual(result.coverage.adapters.map((adapter) => adapter.matched), [0, 0, 0]);
});

test('a missing source is reported instead of throwing', async () => {
  const result = await collectModel({ options: BASE_OPTIONS });

  assert.equal(result.ok, false);
  assert.equal(result.validation.valid, true);
  assert.equal(codesOf(result.diagnostics, CODES.SOURCE_LIST_FAILED).length, 1);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.model.coverage.complete, false);
});

test('one unreadable file does not abort the scan', async () => {
  const { result } = await collect({
    'src/a.js': 'export const a = 1;\n',
    'src/b.js': 'export const b = 1;\n',
  }, {}, { failRead: new Set(['src/a.js']) });

  assert.equal(result.ok, true);
  assert.equal(result.validation.valid, true);
  assert.deepEqual(codesOf(result.diagnostics, CODES.SOURCE_READ_FAILED).map((entry) => entry.path), ['src/a.js']);
  assert.deepEqual(sortedIds(result.model.nodes), ['file:src/b.js']);
});

test('an unparsable manifest is reported instead of guessed', async () => {
  const { result } = await collect({ 'package.json': '{ not json' });

  assert.equal(result.ok, true);
  assert.equal(result.validation.valid, true);
  assert.deepEqual(codesOf(result.unresolved, CODES.UNSUPPORTED_INPUT).map((entry) => entry.path), ['package.json']);
  assert.deepEqual(result.model.nodes, []);
});

test('invalid options fail before the source is touched', async () => {
  let listed = 0;
  const source = {
    listFiles: async () => { listed += 1; return []; },
    readText: async () => '',
  };

  const rejected = [
    undefined,
    {},
    { projectId: 'p' },
    { generatedAt: BASE_OPTIONS.generatedAt },
    { projectId: '', generatedAt: BASE_OPTIONS.generatedAt },
    { projectId: 'p', generatedAt: 'yesterday' },
    { projectId: 'p', generatedAt: BASE_OPTIONS.generatedAt, maxFiles: 0 },
    { projectId: 'p', generatedAt: BASE_OPTIONS.generatedAt, scopeRoots: ['..'] },
  ];

  for (const options of rejected) {
    const result = await collectModel({ source, options });
    assert.equal(result.ok, false, `expected ok=false for ${JSON.stringify(options)}`);
    assert.ok(codesOf(result.diagnostics, CODES.INVALID_OPTION).length > 0, `expected invalid_option for ${JSON.stringify(options)}`);
    assert.equal(result.validation.valid, true);
    assert.deepEqual(result.model.nodes, []);
    assert.equal(result.coverage.complete, false, `coverage must be incomplete for ${JSON.stringify(options)}`);
  }

  assert.equal(listed, 0);
});

test('the result never throws and always keeps the documented shape', async () => {
  const hostile = { source: { listFiles: () => { throw new Error('sync throw'); }, readText: () => { throw new Error('sync throw'); } } };

  for (const input of [undefined, null, 42, 'text', [], {}, { options: null }, { source: null, options: BASE_OPTIONS }, hostile]) {
    const result = await collectModel(input);
    assert.equal(typeof result.ok, 'boolean');
    assert.equal(typeof result.model, 'object');
    assert.equal(typeof result.coverage, 'object');
    assert.ok(Array.isArray(result.unresolved));
    assert.ok(Array.isArray(result.diagnostics));
    assert.equal(result.validation.valid, validateModel(result.model).valid);
    for (const entry of [...result.unresolved, ...result.diagnostics]) {
      assert.ok(isKnownCode(entry.code), `unknown diagnostic code ${entry.code}`);
    }
  }
});

test('the injected source is not mutated', async () => {
  const entries = fixtureEntries();
  const snapshot = JSON.stringify(entries);

  await collect(entries);

  assert.equal(JSON.stringify(entries), snapshot);
});

test('a scope whose every file is ignored is not reported as a complete empty project', async () => {
  // `temp` is on the ignore list, so pointing the collector at such a directory
  // lists files and scans none. That is a withheld scope, not an empty project.
  const entries = {
    'Temp/bigrepo/src/a.js': "const b = require('./b.js');\n",
    'Temp/bigrepo/src/b.js': 'module.exports = 1;\n',
  };
  const { result } = await collect(entries, { scopeRoots: ['Temp/bigrepo'] });

  assert.equal(result.coverage.filesListed, 2);
  assert.equal(result.coverage.filesScanned, 0);
  assert.equal(result.coverage.complete, false, 'a fully ignored scope must not claim complete coverage');
  assert.equal(result.ok, true, 'the run itself succeeded; only coverage is limited');
  assert.equal(result.model.nodes.length, 0);
  const reported = codesOf(result.diagnostics, CODES.NO_FILES_IN_SCOPE);
  assert.equal(reported.length, 1, 'the reason must be visible in the diagnostics');
  assert.match(reported[0].message, /2 file/);
});

test('an empty listing is still reported as complete', async () => {
  // Nothing was listed, so nothing was withheld: that is the one case where an
  // empty model may claim complete coverage.
  const { result } = await collect({}, { scopeRoots: ['.'] });

  assert.equal(result.coverage.filesListed, 0);
  assert.equal(result.coverage.filesScanned, 0);
  assert.equal(result.coverage.complete, true);
  assert.equal(codesOf(result.diagnostics, CODES.NO_FILES_IN_SCOPE).length, 0);
});
