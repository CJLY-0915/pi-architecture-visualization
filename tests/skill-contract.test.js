'use strict';

// The router skill and the 12 scenario skills are the plugin's agent-facing
// surface. The host registers them declaratively, so nothing here runs plugin
// code: these tests guard the parts the host silently degrades — skill ids,
// description length, the routing table and every tool a skill tells the model
// to call.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const manifest = require('../manifest.json');

const SKILLS_DIR = path.join(__dirname, '..', 'skills');
const RULE_MODULE = pathToFileURL(path.join(__dirname, '..', 'extensions', 'workflow-rule.mjs')).href;

// Host limits, read from the installed app.asar (out/main/index.js): a longer
// description is truncated with an ellipsis, which quietly breaks routing.
const MAX_DESCRIPTION_CHARS = 240;

const SKILL_ENTRIES = manifest.contributes.skills;
const TOOL_NAMES = manifest.contributes.agentTools.map((tool) => tool.name);

function frontmatter(raw) {
  const name = /^name:\s*(.+)$/m.exec(raw);
  const description = /^description:\s*(.+)$/m.exec(raw);
  return { name: name && name[1].trim(), description: description && description[1].trim() };
}

function skillBodies() {
  return SKILL_ENTRIES.map((entry) => {
    const raw = fs.readFileSync(path.join(SKILLS_DIR, '..', entry.path), 'utf8');
    return { entry, raw, ...frontmatter(raw) };
  });
}

test('every skill description fits the host limit', () => {
  for (const { entry, description } of skillBodies()) {
    assert.ok(description, `${entry.path} needs a frontmatter description`);
    assert.ok(
      description.length <= MAX_DESCRIPTION_CHARS,
      `${entry.id} description is ${description.length} chars; the host truncates at ${MAX_DESCRIPTION_CHARS}`,
    );
  }
});

test('the router table only points at skills that exist', () => {
  const router = skillBodies().find((skill) => skill.entry.id === 'explore');
  assert.ok(router, 'the explore router skill must be declared');
  const declared = new Set(SKILL_ENTRIES.map((entry) => entry.id));
  const rows = [...router.raw.matchAll(/^\|[^\n]*\|\s*`([a-z0-9-]+)`\s*\|/gm)].map((match) => match[1]);
  assert.ok(rows.length >= 9, `expected the routing table to name the nine scenario skills, found ${rows.length}`);
  for (const id of rows) {
    assert.ok(declared.has(id), `the routing table points at \`${id}\`, which the manifest does not declare`);
  }
});

test('skills only tell the model to call tools that exist', () => {
  for (const { entry, raw } of skillBodies()) {
    for (const match of raw.matchAll(/architecture_[a-z_]+/g)) {
      assert.ok(
        TOOL_NAMES.includes(match[0]),
        `${entry.id} calls \`${match[0]}\`, which is not a declared agent tool`,
      );
    }
  }
});

test('the standing rule names a skill the host actually registers', async () => {
  const { buildStandingRule } = await import(RULE_MODULE);
  const named = /`([^`]+)`/.exec(buildStandingRule());
  assert.ok(named, 'the rule should name the skill in backticks');
  const names = skillBodies().map((skill) => skill.name);
  assert.ok(
    names.includes(named[1]),
    `the rule names \`${named[1]}\`, but no registered skill carries that name`,
  );
});

test('no skill reaches outside its own evidence rules', () => {
  // The skills are prose, but they must not smuggle in shell, network or write
  // instructions: the plugin is read-only by contract.
  for (const { entry, raw } of skillBodies()) {
    assert.doesNotMatch(raw, /\b(?:curl|wget|npm install|sudo|rm -rf)\b/, `${entry.id} must not instruct shell or network use`);
    assert.doesNotMatch(raw, /fs\.write|writeText/, `${entry.id} must not instruct a write; the plugin never writes`);
  }
});
