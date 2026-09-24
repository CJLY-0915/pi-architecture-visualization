'use strict';

// What ships in the .piplug, and what only exists for development.
//
// The host packager walks the directory and does not honour .gitignore, so the
// shipped set has to be stated explicitly and proven complete: every path the
// manifest declares and every module the runtime requires must be inside it,
// and nothing outside it may be needed to load the plugin.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const manifest = require('../manifest.json');

const ROOT = path.join(__dirname, '..');

// Runtime only. Tests, fixtures, docs, the repo's own architecture model and
// every generated or session directory stay out of the distributable.
const SHIP_ROOTS = ['main.js', 'manifest.json', 'package.json', 'src', 'extensions', 'renderer', 'skills'];

// Committed for development, never packaged.
const DEV_ONLY_ROOTS = ['tests', 'fixtures', 'docs', '.github', 'README.md', 'PLAN.md', 'CHANGELOG.md', '.gitignore'];

// Never committed either.
const LOCAL_ONLY = ['architecture', 'dist', 'Temp', '.pi', 'node_modules', 'coverage', '.cache'];

function walk(dir, prefix = '') {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...walk(path.join(dir, entry.name), relative));
    else files.push(relative);
  }
  return files;
}

function isInside(relativePath, roots) {
  return roots.some((root) => relativePath === root || relativePath.startsWith(`${root}/`));
}

const ALL_FILES = walk(ROOT).filter((file) => !file.startsWith('.git/'));
const SHIP_FILES = ALL_FILES.filter((file) => isInside(file, SHIP_ROOTS));

test('the ship set is exactly the declared runtime roots', () => {
  const unexpected = SHIP_FILES.filter((file) => !isInside(file, SHIP_ROOTS));
  assert.deepEqual(unexpected, [], 'the ship set must not contain anything else');
  for (const root of SHIP_ROOTS) {
    assert.ok(
      ALL_FILES.some((file) => isInside(file, [root])),
      `${root} is declared as runtime but does not exist`,
    );
  }
});

test('every path the manifest declares is inside the ship set', () => {
  const declared = [
    manifest.main,
    manifest.ui.panel,
    ...manifest.contributes.agentExtensions,
    ...manifest.contributes.skills.map((entry) => entry.path),
    ...(manifest.contributes.views ?? []).map((view) => view.entry),
  ];
  for (const declaredPath of declared) {
    assert.ok(SHIP_FILES.includes(declaredPath), `${declaredPath} is declared by the manifest but is not shipped`);
  }
});

test('every module the runtime requires is inside the ship set', () => {
  const sources = SHIP_FILES.filter((file) => file.endsWith('.js'));
  const required = new Set();
  for (const source of sources) {
    const raw = fs.readFileSync(path.join(ROOT, source), 'utf8');
    for (const match of raw.matchAll(/require\('(\.[^']+)'\)/g)) {
      const base = path.join(path.dirname(source), match[1]);
      const candidates = [base, `${base}.js`, `${base}.json`, path.join(base, 'index.js')];
      const resolved = candidates.find((candidate) => SHIP_FILES.includes(candidate.split(path.sep).join('/')));
      assert.ok(resolved, `${source} requires ${match[1]}, which is not shipped`);
      required.add(resolved.split(path.sep).join('/'));
    }
  }
  assert.ok(required.size > 0, 'the runtime must require something');
});

test('development-only assets are tracked but not shipped', () => {
  for (const root of DEV_ONLY_ROOTS) {
    assert.ok(
      ALL_FILES.some((file) => isInside(file, [root])),
      `${root} is a development asset and should exist in the repository`,
    );
    assert.ok(
      !SHIP_FILES.some((file) => isInside(file, [root])),
      `${root} must not be packaged`,
    );
  }
});

test('local-only directories are neither shipped nor tracked', () => {
  for (const root of LOCAL_ONLY) {
    assert.ok(
      !SHIP_FILES.some((file) => isInside(file, [root])),
      `${root} must not be packaged`,
    );
    const tracked = require('node:child_process')
      .execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    assert.ok(
      !tracked.some((file) => isInside(file, [root])),
      `${root} must not be tracked by git`,
    );
  }
});

test('the ship set carries no logs, caches or credential-shaped files', () => {
  for (const file of SHIP_FILES) {
    assert.doesNotMatch(file, /\.(log|tmp|cache)$/, `${file} must not be packaged`);
    assert.doesNotMatch(file, /(^|\/)\.env/, `${file} looks like a credential file`);
  }
});

test('the manifest and package versions stay in step', () => {
  assert.equal(manifest.version, require('../package.json').version,
    'manifest.json and package.json must declare the same version');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/, 'the version must be a semver triple');
});

// A test that reads a local-only directory passes on the machine that has the
// directory and fails everywhere else. `architecture/` holds this repository's
// own model, is gitignored, and is exactly how the export-preview budget guard
// stopped running on CI: green locally, ENOENT on all three platforms. Any
// data a test needs has to be committed, which for a model means a fixture.
test('no test reads a local-only directory', () => {
  const offenders = [];
  for (const file of ALL_FILES.filter((entry) => /^tests\/.*\.test\.js$/.test(entry))) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    // The dangerous shape is a filesystem join naming a local-only directory;
    // a bare 'architecture/model.json' string is an in-memory path handed to a
    // stubbed host and stays legitimate.
    for (const match of source.matchAll(/path\.join\(([^)]*)\)/g)) {
      const segments = [...match[1].matchAll(/'([^']*)'/g)].map((segment) => segment[1]);
      const hit = segments.find((segment) => LOCAL_ONLY.includes(segment));
      if (hit) offenders.push(`${file}: path.join reaches the local-only directory ${hit}`);
    }
    for (const match of source.matchAll(/require\((['"])(\.\.?\/[^'"]+)\1\)/g)) {
      const first = match[2].split('/')[1];
      if (LOCAL_ONLY.includes(first)) offenders.push(`${file}: require reaches the local-only directory ${first}`);
    }
  }
  assert.deepEqual(offenders, [], 'a test must never depend on a directory CI does not have');
});

// The marketplace package audit (SEC003) is a text scan with no parser: a
// literal `import(` or `require(` shape whose argument is not a string reads as
// dynamic module loading and blocks the upload. Nothing in this plugin loads a
// module dynamically, so the shipped set must not contain that shape at all —
// not in code, and not in a comment or a diagnostic message describing one.
// Rewording the prose is the fix; reintroducing the parentheses is not.
test('the ship set carries no call-shaped dynamic module load', () => {
  const CALLEE = /\b(?:import|require)\s*\(/g;
  const STRING_LITERAL_ARGUMENT = /^\s*(['"])(?:\\.|(?!\1).)*\1\s*[,)]/;
  const offenders = [];
  for (const file of SHIP_FILES) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    source.split('\n').forEach((line, index) => {
      for (const match of line.matchAll(CALLEE)) {
        const argument = line.slice(match.index + match[0].length);
        if (STRING_LITERAL_ARGUMENT.test(argument)) continue;
        offenders.push(`${file}:${index + 1}: ${match[0].trim()} with a non-literal argument`);
      }
    });
  }
  assert.deepEqual(offenders, [], 'a call-shaped dynamic module load reads as dynamic code execution to the package audit');
});
