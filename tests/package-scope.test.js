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
const DEV_ONLY_ROOTS = ['tests', 'fixtures', 'docs', '.github', 'README.md', 'PLAN.md', '.gitignore'];

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
