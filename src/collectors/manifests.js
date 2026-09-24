'use strict';

const { CODES } = require('../core/error-codes');
const { externalNodeId, containerNodeId } = require('./ids');

// manifests adapter: package/workspace containers and declared dependencies.
//
// Supported range (line-oriented heuristics, not a parser):
//   - package.json: `name` and each `workspaces` entry -> container node;
//     `scripts` attached as the extra `scripts` field (keys sorted) on the
//     package container; dependencies/devDependencies/peerDependencies keys ->
//     one `external` node per declared package, evidence = that package.json
//   - requirements.txt: `name`, `name==version`, `name>=version` lines
//   - pyproject.toml: only `name = "..."` and a single-line
//     `dependencies = [ ... ]` inside `[project]` or `[tool.poetry]`
//   - go.mod: `module` -> container node; `require` lines (single line or
//     parenthesised require block) -> `external` nodes
//   - pom.xml: `<dependency>` blocks with `<groupId>`/`<artifactId>`
//   - build.gradle: `implementation "group:artifact:version"` style string
//     dependencies (optional parentheses)
//
// Every dependency id is `external:<name>`, shared with the js-ts adapter, so a
// declared dependency and an import of it merge into one node with merged
// evidence. Dependency nodes are always confirmed: the manifest that declares
// them is the evidence.
//
// Limitations, reported instead of guessed (`unsupported_input`):
//   - package.json that is not a JSON object, non-string workspaces entries,
//     dependency fields that are not objects, non-string scripts
//   - requirements.txt lines that are not one of the three accepted forms
//     (extras, ~=, ==, -r, -e, URLs, environment markers)
//   - pyproject.toml multi-line or table-form `dependencies`, and any
//     non-quoted `name`; TOML is NOT parsed, so nested sections are ignored
//   - go.mod `require` entries without `module version`; other directives
//     (`replace`, `exclude`, `retract`, `toolchain`) are ignored silently
//   - pom.xml `<dependency>` without both coordinates
//   - build.gradle dependency notation other than a `group:artifact:version`
//     string (for example `project(':core')` or interpolated strings)

const MANIFEST_NAMES = Object.freeze(['package.json', 'requirements.txt', 'pyproject.toml', 'go.mod', 'pom.xml', 'build.gradle']);
const DEPENDENCY_FIELDS = Object.freeze(['dependencies', 'devDependencies', 'peerDependencies']);
const PYTHON_REQUIREMENT_PATTERN = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:(?:==|>=)\s*([^\s;#]+))?$/;
const PYTHON_NAME_PATTERN = /^([A-Za-z0-9][A-Za-z0-9._-]*)/;
const PYTHON_SECTIONS = Object.freeze(['project', 'tool.poetry']);
const REQUIRE_BLOCK_PATTERN = /^require\s*\($/;
const REQUIRE_LINE_PATTERN = /^require\s+(\S+)\s+(\S+)$/;
const GO_REQUIRE_ENTRY_PATTERN = /^(\S+)\s+(\S+)$/;
const MODULE_LINE_PATTERN = /^module\s+(\S+)$/;
const DEPENDENCY_BLOCK_PATTERN = /<dependency\b[^>]*>([\s\S]*?)<\/dependency>/g;
const GRADLE_STRING_DEPENDENCY_PATTERN = /^([A-Za-z][A-Za-z0-9]*)\s*\(?\s*(['"])([^'"]+)\2\s*\)?$/;
const GRADLE_DEPENDENCY_CONFIGURATION_PATTERN = /^(implementation|api|compile|compileOnly|runtimeOnly|testImplementation|testCompileOnly|testRuntimeOnly|annotationProcessor|classpath|developmentOnly)\b/;
const TOML_ASSIGNMENT_PATTERN = /^([A-Za-z0-9._-]+)\s*=\s*(.*)$/;
const TOML_SECTION_PATTERN = /^\[([^\]]+)\]$/;
const TOML_QUOTED_STRING_PATTERN = /^(['"])(.*)\1$/;

function basenameOf(path) {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}

function stripHashComment(line) {
  const index = line.indexOf('#');
  return (index === -1 ? line : line.slice(0, index)).trim();
}

function stripSlashComment(line) {
  const index = line.indexOf('//');
  return (index === -1 ? line : line.slice(0, index)).trim();
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sortedKeys(object) {
  return Object.keys(object).sort();
}

// Returns null when the scripts field is absent or empty; throws nothing.
function collectScripts(value, reportUnsupported) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) {
    reportUnsupported('the "scripts" field is not an object; no script entries were collected.');
    return null;
  }
  const entries = {};
  for (const key of sortedKeys(value)) {
    if (typeof value[key] === 'string') entries[key] = value[key];
  }
  return Object.keys(entries).length === 0 ? null : entries;
}

function addDependency(context, name, evidenceId) {
  context.addNode({
    id: externalNodeId(name),
    name,
    type: 'external',
    status: 'confirmed',
    confidence: 'high',
    evidenceIds: [evidenceId],
  });
}

function addContainer(context, kind, key, name, evidenceId, extra) {
  context.addNode(Object.assign({
    id: containerNodeId(kind, key),
    name,
    type: 'container',
    status: 'confirmed',
    confidence: 'high',
    evidenceIds: [evidenceId],
  }, extra));
}

function analyzePackageJson(file, context) {
  const evidenceId = context.addEvidence({ path: file.path, type: 'config' });
  let manifest;
  try {
    manifest = JSON.parse(file.text);
  } catch {
    manifest = null;
  }
  if (!isPlainObject(manifest)) {
    context.unresolved(CODES.UNSUPPORTED_INPUT, file.path, 'package.json is not a JSON object; no package metadata was derived.');
    return;
  }

  const declaredName = typeof manifest.name === 'string' && manifest.name.trim() !== '' ? manifest.name.trim() : null;
  const scripts = collectScripts(manifest.scripts, (message) => context.unresolved(CODES.UNSUPPORTED_INPUT, file.path, message));
  const extra = scripts === null ? {} : { scripts };
  addContainer(context, 'package', file.path, declaredName === null ? file.path : declaredName, evidenceId, extra);

  if (manifest.workspaces !== undefined) {
    if (!Array.isArray(manifest.workspaces)) {
      context.unresolved(CODES.UNSUPPORTED_INPUT, file.path, 'the "workspaces" field is not an array; no workspace containers were derived.');
    } else {
      manifest.workspaces.forEach((entry, index) => {
        if (typeof entry !== 'string' || entry.trim() === '') {
          context.unresolved(CODES.UNSUPPORTED_INPUT, file.path,
            `workspaces[${index}] is not a non-empty string; no workspace container was derived.`);
          return;
        }
        addContainer(context, 'workspace', `${file.path}#${entry}`, entry.trim(), evidenceId);
      });
    }
  }

  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = manifest[field];
    if (dependencies === undefined || dependencies === null) continue;
    if (!isPlainObject(dependencies)) {
      context.unresolved(CODES.UNSUPPORTED_INPUT, file.path,
        `the "${field}" field is not an object; no dependency nodes were derived from it.`);
      continue;
    }
    for (const name of sortedKeys(dependencies)) {
      if (name.trim() === '') {
        context.unresolved(CODES.UNSUPPORTED_INPUT, file.path, `"${field}" declares an empty dependency name.`);
        continue;
      }
      addDependency(context, name, evidenceId);
    }
  }
}

function analyzeRequirements(file, context) {
  const evidenceId = context.addEvidence({ path: file.path, type: 'config' });
  file.text.split(/\r?\n/).forEach((raw, index) => {
    const lineNumber = index + 1;
    const line = stripHashComment(raw.trim());
    if (line === '') return;
    const match = line.match(PYTHON_REQUIREMENT_PATTERN);
    if (match === null) {
      context.unresolved(CODES.UNSUPPORTED_INPUT, file.path,
        `Line ${lineNumber}: "${line}" is not a name, name==version or name>=version requirement; nothing was inferred.`);
      return;
    }
    addDependency(context, match[1], evidenceId);
  });
}

function splitTomlArray(value) {
  if (!value.endsWith(']')) return null;
  const inner = value.slice(1, -1).trim();
  if (inner === '') return [];
  return inner.split(',').map((entry) => {
    const trimmed = entry.trim();
    const quoted = trimmed.match(TOML_QUOTED_STRING_PATTERN);
    return quoted === null ? trimmed : quoted[2].trim();
  });
}

function analyzePyproject(file, context) {
  const evidenceId = context.addEvidence({ path: file.path, type: 'config' });
  let section = null;

  file.text.split(/\r?\n/).forEach((raw, index) => {
    const lineNumber = index + 1;
    const line = stripHashComment(raw.trim());
    if (line === '') return;

    const sectionMatch = line.match(TOML_SECTION_PATTERN);
    if (sectionMatch !== null) {
      section = sectionMatch[1].trim();
      return;
    }
    if (!PYTHON_SECTIONS.includes(section)) return;

    const assignment = line.match(TOML_ASSIGNMENT_PATTERN);
    if (assignment === null) return;
    const key = assignment[1];
    const value = assignment[2].trim();

    if (key === 'name') {
      const quoted = value.match(TOML_QUOTED_STRING_PATTERN);
      if (quoted === null || quoted[2].trim() === '') {
        context.unresolved(CODES.UNSUPPORTED_INPUT, file.path,
          `Line ${lineNumber}: "${key}" is not a plain quoted string; no container node was derived.`);
        return;
      }
      const name = quoted[2].trim();
      addContainer(context, 'python', `${file.path}#${name}`, name, evidenceId);
      return;
    }

    if (key !== 'dependencies') return;
    if (!value.startsWith('[')) {
      context.unresolved(CODES.UNSUPPORTED_INPUT, file.path,
        `Line ${lineNumber}: only a single-line "dependencies = [...]" array is modeled; "${value}" was not parsed.`);
      return;
    }
    const entries = splitTomlArray(value);
    if (entries === null) {
      context.unresolved(CODES.UNSUPPORTED_INPUT, file.path,
        `Line ${lineNumber}: the "dependencies" array is not closed on this line (multi-line TOML is not modeled).`);
      return;
    }
    entries.forEach((entry) => {
      const match = entry.match(PYTHON_NAME_PATTERN);
      if (match === null) {
        context.unresolved(CODES.UNSUPPORTED_INPUT, file.path,
          `Line ${lineNumber}: dependency entry "${entry}" does not start with a package name; nothing was inferred.`);
        return;
      }
      addDependency(context, match[1], evidenceId);
    });
  });
}

function analyzeGoMod(file, context) {
  const evidenceId = context.addEvidence({ path: file.path, type: 'config' });
  let moduleName = null;
  let inRequireBlock = false;

  const addRequire = (entry, lineNumber) => {
    const match = entry.match(GO_REQUIRE_ENTRY_PATTERN);
    if (match === null) {
      context.unresolved(CODES.UNSUPPORTED_INPUT, file.path,
        `Line ${lineNumber}: require entry "${entry}" is not "module version"; nothing was inferred.`);
      return;
    }
    addDependency(context, match[1], evidenceId);
  };

  file.text.split(/\r?\n/).forEach((raw, index) => {
    const lineNumber = index + 1;
    const line = stripSlashComment(raw.trim());
    if (line === '') return;

    if (inRequireBlock) {
      if (line === ')') {
        inRequireBlock = false;
        return;
      }
      addRequire(line, lineNumber);
      return;
    }
    if (REQUIRE_BLOCK_PATTERN.test(line)) {
      inRequireBlock = true;
      return;
    }

    const single = line.match(REQUIRE_LINE_PATTERN);
    if (single !== null) {
      addRequire(`${single[1]} ${single[2]}`, lineNumber);
      return;
    }
    const moduleLine = line.match(MODULE_LINE_PATTERN);
    if (moduleLine !== null) moduleName = moduleLine[1];
  });

  if (moduleName !== null) addContainer(context, 'go-module', `${file.path}#${moduleName}`, moduleName, evidenceId);
}

function tagValue(block, tag) {
  const match = block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  if (match === null) return null;
  const value = match[1].trim();
  return value === '' ? null : value;
}

function analyzePom(file, context) {
  const evidenceId = context.addEvidence({ path: file.path, type: 'config' });
  let index = 0;
  for (const match of file.text.matchAll(DEPENDENCY_BLOCK_PATTERN)) {
    index += 1;
    const groupId = tagValue(match[1], 'groupId');
    const artifactId = tagValue(match[1], 'artifactId');
    if (groupId === null || artifactId === null) {
      context.unresolved(CODES.UNSUPPORTED_INPUT, file.path,
        `dependency[${index}] does not declare both groupId and artifactId; nothing was inferred.`);
      continue;
    }
    addDependency(context, `${groupId}:${artifactId}`, evidenceId);
  }
}

function analyzeGradle(file, context) {
  const evidenceId = context.addEvidence({ path: file.path, type: 'config' });
  file.text.split(/\r?\n/).forEach((raw, index) => {
    const lineNumber = index + 1;
    const line = stripSlashComment(raw.trim());
    if (line === '') return;

    const stringDependency = line.match(GRADLE_STRING_DEPENDENCY_PATTERN);
    if (stringDependency !== null) {
      const parts = stringDependency[3].split(':');
      if (parts.length >= 2 && parts[0].trim() !== '' && parts[1].trim() !== '') {
        addDependency(context, `${parts[0].trim()}:${parts[1].trim()}`, evidenceId);
      } else {
        context.unresolved(CODES.UNSUPPORTED_INPUT, file.path,
          `Line ${lineNumber}: gradle dependency "${stringDependency[3]}" is not "group:artifact:version"; nothing was inferred.`);
      }
      return;
    }
    if (GRADLE_DEPENDENCY_CONFIGURATION_PATTERN.test(line)) {
      context.unresolved(CODES.UNSUPPORTED_INPUT, file.path,
        `Line ${lineNumber}: gradle notation "${line}" is not a "group:artifact:version" string; nothing was inferred.`);
    }
  });
}

const ANALYZERS = Object.freeze({
  'package.json': analyzePackageJson,
  'requirements.txt': analyzeRequirements,
  'pyproject.toml': analyzePyproject,
  'go.mod': analyzeGoMod,
  'pom.xml': analyzePom,
  'build.gradle': analyzeGradle,
});

module.exports = {
  create() {
    return {
      id: 'manifests',
      match: (path) => MANIFEST_NAMES.includes(basenameOf(path)),
      analyze(file, context) {
        ANALYZERS[basenameOf(file.path)](file, context);
      },
    };
  },
};
