'use strict';

// Contract tests for the two manifest contributions that the host derives ids
// for: `contributes.skills` and `contributes.agentExtensions`.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MANIFEST = require('../manifest.json');

const SKILL_ENTRIES = MANIFEST.contributes.skills;
const EXTENSION_ENTRIES = MANIFEST.contributes.agentExtensions;

// Mirrors the host's `skillIdFromPath` (app.asar `out/main/index.js`): it takes
// the basename only. Every skill in this plugin is called `SKILL.md`, so a
// declared path without an explicit id would collapse onto one id and the host
// would register the first entry and skip the rest as DUPLICATE.
function hostSkillIdFromPath(relativePath) {
  const base = relativePath.split(/[\\/]/).pop() ?? relativePath;
  return base.replace(/\.[^.]+$/, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'skill';
}

test('every declared skill carries an explicit id', () => {
  assert.ok(SKILL_ENTRIES.length > 0, 'the plugin declares skills');
  for (const entry of SKILL_ENTRIES) {
    assert.equal(typeof entry, 'object', `skill entry must be an object: ${JSON.stringify(entry)}`);
    assert.ok(typeof entry.path === 'string' && entry.path.trim(), 'a skill entry needs a path');
    assert.ok(typeof entry.id === 'string' && entry.id.trim(), `skill ${entry.path} needs an explicit id`);
  }
});

test('skill ids are unique and match their directory', () => {
  const ids = SKILL_ENTRIES.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate skill ids: ${ids.join(', ')}`);
  for (const entry of SKILL_ENTRIES) {
    assert.equal(entry.id, path.basename(path.dirname(entry.path)), `id of ${entry.path} should be its directory`);
  }
});

test('relying on the host path-derived id would collide', () => {
  // The regression guard: if someone reintroduces bare path strings, the host
  // id for every skill becomes the same slug.
  const derived = SKILL_ENTRIES.map((entry) => hostSkillIdFromPath(entry.path));
  assert.equal(new Set(derived).size, 1, 'every SKILL.md basename derives the same host id');
  const declared = SKILL_ENTRIES.map((entry) => entry.id);
  assert.notEqual(new Set(declared).size, 1, 'the declared ids must not share that fate');
});

test('declared skill files exist', () => {
  for (const entry of SKILL_ENTRIES) {
    const skillPath = path.join(__dirname, '..', entry.path);
    assert.ok(fs.existsSync(skillPath), `missing skill file: ${entry.path}`);
    const raw = fs.readFileSync(skillPath, 'utf8');
    assert.match(raw, /^name:/m, `${entry.path} needs a frontmatter name`);
    assert.match(raw, /^description:/m, `${entry.path} needs a frontmatter description`);
  }
});

test('the agent extension is declared with its permission', () => {
  assert.deepEqual(EXTENSION_ENTRIES, ['extensions/workflow-rule.mjs']);
  assert.ok(MANIFEST.permissions.includes('agent.extension'), 'agentExtensions requires the agent.extension permission');
  for (const entry of EXTENSION_ENTRIES) {
    assert.match(entry, /\.(ts|mts|js|mjs)$/, `${entry} must be a .ts or .js module`);
    assert.ok(fs.existsSync(path.join(__dirname, '..', entry)), `missing extension module: ${entry}`);
  }
});
