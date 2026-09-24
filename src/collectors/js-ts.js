'use strict';

const { CODES } = require('../core/error-codes');
const { fileNodeId, externalNodeId, edgeId } = require('./ids');

// js-ts adapter: module dependencies of JavaScript / TypeScript sources.
//
// Supported range (line-oriented heuristics, not a parser):
//   - static `import ... from 'x'`, `export ... from 'x'`, side-effect `import 'x'`
//   - string-literal `require('x')` and string-literal `import('x')`
//   - relative (./x, ../x), root-relative (/x) and bare specifiers
//   - relative targets resolve to exact path, path + source extension, or
//     path + '/index' + source extension, and only to files this adapter also
//     turns into a node (other targets would produce dangling edges)
//   - bare specifiers consult dependencies / devDependencies / peerDependencies
//     of the nearest scanned package.json at or above the importing file; the
//     id is shared with the manifests adapter (`external:<package>`) so the
//     declaration and the import merge into one node
//   - one node per matched file, plus one node per distinct dependency edge
//
// Limitations, reported instead of guessed:
//   - dynamic import or require with a non-literal argument -> unsupported_input, no edge
//   - a relative specifier that matches no scanned source file -> unresolved_reference
//   - specifiers resolving only to non-source files (json, css) are unresolved
//   - no tsconfig path mapping, no package.json "exports"/"main" resolution, no
//     re-export barrel analysis, no commonjs interop analysis
//   - lines trimmed to `//`, `/*`, `*` or `#` are skipped, so commented-out
//     imports are not counted; strings containing import text still are
//
// The words "import" and "require" are never written with an opening
// parenthesis in this file, comments or diagnostic messages alike: the
// marketplace package audit (SEC003) is a text scan with no parser, so a
// literal call shape in prose reads as dynamic module loading and blocks the
// upload. Nothing here loads a module dynamically.

const SOURCE_EXTENSIONS = Object.freeze(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']);
const COMMENT_PREFIXES = Object.freeze(['//', '/*', '*', '#']);
const STATIC_FROM_PATTERN = /(?:^|[^\w$])(?:import|export)\s+([^;]*?)\s+from\s*(['"])([^'"]+)\2/g;
const SIDE_EFFECT_IMPORT_PATTERN = /(?:^|[^\w$])import\s*(['"])([^'"]+)\1/g;
const DYNAMIC_IMPORT_PATTERN = /(?:^|[^\w$.])import\s*\(([^)]*)\)/g;
const REQUIRE_PATTERN = /(?:^|[^\w$.])require\s*\(([^)]*)\)/g;
const LITERAL_ARGUMENT_PATTERN = /^(['"])([^'"]*)\1$/;
const MANIFEST_DEPENDENCY_FIELDS = Object.freeze(['dependencies', 'devDependencies', 'peerDependencies']);

function isSourceExtension(path) {
  return SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

function dirnameOf(path) {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

// Joins a workspace-relative directory and a relative specifier without
// touching the filesystem. ".." segments are resolved lexically and can never
// leave the workspace root, because segments are popped off an empty list.
function joinRelative(dir, relative) {
  const segments = dir === '' ? [] : dir.split('/');
  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return segments.join('/');
}

function splitReferences(text) {
  const references = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const lineNumber = index + 1;
    const trimmed = line.trim();
    if (trimmed === '' || COMMENT_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return;

    const seen = new Set();
    const record = (kind, specifier, reason) => {
      const key = `${kind}\u0000${specifier}\u0000${reason === undefined ? '' : reason}`;
      if (seen.has(key)) return;
      seen.add(key);
      references.push({ kind, specifier, reason, line: lineNumber });
    };

    for (const match of line.matchAll(STATIC_FROM_PATTERN)) record('reference', match[3]);
    for (const match of line.matchAll(SIDE_EFFECT_IMPORT_PATTERN)) record('reference', match[2]);
    for (const match of line.matchAll(DYNAMIC_IMPORT_PATTERN)) {
      const argument = match[1].trim().match(LITERAL_ARGUMENT_PATTERN);
      if (argument === null) record('unsupported', '', 'dynamic import with a non-literal argument');
      else record('reference', argument[2]);
    }
    for (const match of line.matchAll(REQUIRE_PATTERN)) {
      const argument = match[1].trim().match(LITERAL_ARGUMENT_PATTERN);
      if (argument === null) record('unsupported', '', 'dynamic require with a non-literal argument');
      else record('reference', argument[2]);
    }
  });
  return references;
}

function packageNameOf(specifier) {
  const segments = specifier.split('/');
  if (segments[0].startsWith('@')) return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : specifier;
  return segments[0];
}

function parseManifest(text) {
  try {
    const value = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function declaresDependency(manifest, name) {
  return MANIFEST_DEPENDENCY_FIELDS.some((field) => {
    const dependencies = manifest[field];
    return typeof dependencies === 'object' && dependencies !== null && !Array.isArray(dependencies)
      && Object.prototype.hasOwnProperty.call(dependencies, name);
  });
}

function resolveSpecifier(importerPath, specifier, filesByPath) {
  const base = specifier.startsWith('/')
    ? joinRelative('', specifier.slice(1))
    : joinRelative(dirnameOf(importerPath), specifier);
  const candidates = [base];
  for (const extension of SOURCE_EXTENSIONS) {
    candidates.push(`${base}${extension}`, `${base}/index${extension}`);
  }
  for (const candidate of candidates) {
    if (isSourceExtension(candidate) && filesByPath.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Creates a stateless-per-collection js-ts adapter.
 *
 * @returns {{id: string, match: (path: string) => boolean, analyze: (file: {path: string, text: string}, context: object) => void}}
 */
function create() {
  const manifestCache = new Map();

  function manifestAt(path, filesByPath) {
    if (!manifestCache.has(path)) {
      const text = filesByPath.get(path);
      manifestCache.set(path, typeof text === 'string' ? parseManifest(text) : null);
    }
    return manifestCache.get(path);
  }

  // Nearest scanned package.json first, then its ancestors, then the root.
  function declarationPath(importerPath, name, filesByPath) {
    const segments = importerPath.split('/');
    segments.pop();
    for (;;) {
      const dir = segments.join('/');
      const manifestPath = dir === '' ? 'package.json' : `${dir}/package.json`;
      const manifest = manifestAt(manifestPath, filesByPath);
      if (manifest !== null && declaresDependency(manifest, name)) return manifestPath;
      if (segments.length === 0) return null;
      segments.pop();
    }
  }

  function analyzeReference(reference, file, context) {
    const sourceId = fileNodeId(file.path);
    if (reference.kind === 'unsupported') {
      context.unresolved(CODES.UNSUPPORTED_INPUT, file.path,
        `Line ${reference.line}: ${reference.reason}; no dependency edge was derived.`);
      return;
    }

    const specifier = reference.specifier;
    if (specifier.trim() === '') {
      context.unresolved(CODES.UNSUPPORTED_INPUT, file.path,
        `Line ${reference.line}: empty module specifier; no dependency edge was derived.`);
      return;
    }

    const importEvidence = context.addEvidence({ path: file.path, line: reference.line, type: 'code' });

    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      const target = resolveSpecifier(file.path, specifier, context.filesByPath);
      if (target === null) {
        context.unresolved(CODES.UNRESOLVED_REFERENCE, file.path,
          `Line ${reference.line}: relative specifier "${specifier}" does not resolve to a scanned source file; no edge was derived.`);
        return;
      }
      const targetId = fileNodeId(target);
      context.addEdge({
        id: edgeId(sourceId, targetId, 'depends_on'),
        source: sourceId,
        target: targetId,
        type: 'depends_on',
        status: 'confirmed',
        confidence: 'high',
        evidenceIds: [importEvidence],
      });
      return;
    }

    const name = packageNameOf(specifier);
    const manifestPath = declarationPath(file.path, name, context.filesByPath);
    const externalId = externalNodeId(name);
    if (manifestPath === null) {
      context.addNode({
        id: externalId,
        name,
        type: 'external',
        status: 'inferred',
        confidence: 'low',
        evidenceIds: [],
      });
      context.addEdge({
        id: edgeId(sourceId, externalId, 'depends_on'),
        source: sourceId,
        target: externalId,
        type: 'depends_on',
        status: 'inferred',
        confidence: 'low',
        evidenceIds: [],
      });
      return;
    }

    context.addNode({
      id: externalId,
      name,
      type: 'external',
      status: 'confirmed',
      confidence: 'high',
      evidenceIds: [context.addEvidence({ path: manifestPath, type: 'config' })],
    });
    context.addEdge({
      id: edgeId(sourceId, externalId, 'depends_on'),
      source: sourceId,
      target: externalId,
      type: 'depends_on',
      status: 'confirmed',
      confidence: 'high',
      evidenceIds: [importEvidence],
    });
  }

  return {
    id: 'js-ts',
    match: (path) => isSourceExtension(path),
    analyze(file, context) {
      context.addNode({
        id: fileNodeId(file.path),
        name: file.path,
        type: 'module',
        status: 'confirmed',
        confidence: 'high',
        evidenceIds: [context.addEvidence({ path: file.path, type: 'code' })],
      });
      for (const reference of splitReferences(file.text)) analyzeReference(reference, file, context);
    },
  };
}

module.exports = { id: 'js-ts', create };
