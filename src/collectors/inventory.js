'use strict';

const { CODES } = require('../core/error-codes');

// Deterministic read-only inventory.
//
// Responsibilities: path safety, sensitive-path rejection, ignore rules, scope
// containment, and the maxFiles / maxFileChars / totalCharBudget / timeoutMs
// limits. The inventory never touches the filesystem or the network: every byte
// comes from the injected `source`. Candidate files are always processed in
// ascending path order, so the order returned by source.listFiles() can only
// change the filesListed count, never any other output.
//
// Precedence per listed entry: unsafe -> sensitive -> ignored -> out of scope.
// Unsafe and sensitive entries become unresolved entries; ignored and
// out-of-scope entries are counted in filesListed only. `.git/**` is sensitive
// (rule precedence), so it never reaches the ignore list.

const IGNORED_DIRECTORIES = Object.freeze([
  '.git', 'node_modules', 'dist', 'build', 'out', 'vendor', 'coverage', '.next', 'target', 'temp',
]);
const IGNORED_SUFFIXES = Object.freeze(['.min.js', '.map', '.lock']);
const BINARY_SUFFIXES = Object.freeze([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.pdf', '.zip', '.gz',
  '.woff', '.woff2', '.ttf', '.eot', '.wasm', '.exe', '.dll', '.so', '.dylib', '.class', '.jar', '.pyc',
]);
const SENSITIVE_DIRECTORIES = Object.freeze(['.ssh', '.aws', '.git']);
const SENSITIVE_FILE_NAMES = Object.freeze(['.npmrc']);
const SENSITIVE_SUFFIXES = Object.freeze(['.pem', '.key', '.p12', '.pfx']);
const SENSITIVE_PREFIXES = Object.freeze(['id_rsa', 'credentials', 'secrets']);
const DRIVE_LETTER_PATTERN = /^[A-Za-z]:/;

function describe(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `the string ${JSON.stringify(value)}`;
  if (typeof value === 'object') return 'an object';
  return String(value);
}

// Non-string entries still need a stable, sortable label for the unresolved
// list; the label never reaches source.readText().
function describeEntry(value) {
  return typeof value === 'string' ? value : String(value);
}

function unsafeReason(path) {
  if (path.trim() === '') return 'empty';
  if (path.includes('\\')) return 'backslash_separator';
  if (path.startsWith('/') || DRIVE_LETTER_PATTERN.test(path)) return 'absolute_path';
  for (const segment of path.split('/')) {
    if (segment === '') return 'empty_segment';
    if (segment === '.' || segment === '..') return 'dot_segment';
  }
  return null;
}

// Directory patterns match any path segment, file patterns match the basename.
function isSensitivePath(path) {
  const segments = path.split('/');
  const base = segments[segments.length - 1].toLowerCase();
  for (const segment of segments) {
    const value = segment.toLowerCase();
    if (SENSITIVE_DIRECTORIES.includes(value)) return true;
    if (SENSITIVE_FILE_NAMES.includes(value)) return true;
    if (value === '.env' || value.startsWith('.env.')) return true;
  }
  if (SENSITIVE_SUFFIXES.some((suffix) => base.endsWith(suffix))) return true;
  return SENSITIVE_PREFIXES.some((prefix) => base.startsWith(prefix));
}

function isIgnoredPath(path) {
  const segments = path.split('/');
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (IGNORED_DIRECTORIES.includes(segments[index].toLowerCase())) return true;
  }
  const base = segments[segments.length - 1].toLowerCase();
  return IGNORED_SUFFIXES.some((suffix) => base.endsWith(suffix))
    || BINARY_SUFFIXES.some((suffix) => base.endsWith(suffix));
}

function isWithinScope(path, roots) {
  return roots.some((root) => root === '.' || path === root || path.startsWith(`${root}/`));
}

function comparePaths(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

// A failed listing yields no file list at all, so coverage can never be claimed
// as complete here: reporting complete would present "nothing was scanned" as
// "everything was scanned and the project is empty".
function emptyResult(filesListed, unresolved, diagnostics) {
  return {
    filesListed,
    filesScanned: 0,
    filesSkipped: 0,
    complete: false,
    files: [],
    unanalyzed: [],
    unresolved,
    diagnostics,
  };
}

/**
 * Lists, filters and reads the workspace through the injected source.
 *
 * @param {{source: {listFiles: () => Promise<string[]>, readText: (path: string) => Promise<string>}, options: object}} input
 * @returns {Promise<{filesListed: number, filesScanned: number, filesSkipped: number, complete: boolean, files: Array<{path: string, text: string}>, unanalyzed: string[], unresolved: Array<object>, diagnostics: Array<object>}>}
 */
async function collect({ source, options }) {
  const diagnostics = [];
  const unresolved = [];

  let listed;
  try {
    listed = await source.listFiles();
  } catch {
    diagnostics.push({ code: CODES.SOURCE_LIST_FAILED, path: '', message: 'source.listFiles() failed; no files were collected.' });
    return emptyResult(0, unresolved, diagnostics);
  }
  if (!Array.isArray(listed)) {
    diagnostics.push({ code: CODES.SOURCE_LIST_FAILED, path: '', message: `source.listFiles() must return an array of paths, received ${describe(listed)}.` });
    return emptyResult(0, unresolved, diagnostics);
  }

  const candidates = [];
  const seen = new Set();
  for (const entry of listed) {
    if (typeof entry !== 'string') {
      unresolved.push({ code: CODES.UNSAFE_PATH_SKIPPED, path: describeEntry(entry), message: 'The listed entry is not a string and was not read.' });
      continue;
    }
    const reason = unsafeReason(entry);
    if (reason !== null) {
      unresolved.push({ code: CODES.UNSAFE_PATH_SKIPPED, path: entry, message: `Unsafe workspace path (${reason}); the file was not read.` });
      continue;
    }
    if (seen.has(entry)) continue;
    seen.add(entry);
    if (isSensitivePath(entry)) {
      unresolved.push({ code: CODES.SENSITIVE_PATH_SKIPPED, path: entry, message: 'The path matches a sensitive pattern and was not read.' });
      continue;
    }
    if (isIgnoredPath(entry)) continue;
    if (!isWithinScope(entry, options.scopeRoots)) continue;
    candidates.push(entry);
  }

  candidates.sort(comparePaths);

  let readable = candidates;
  if (candidates.length > options.maxFiles) {
    readable = candidates.slice(0, options.maxFiles);
    diagnostics.push({
      code: CODES.FILE_LIMIT_REACHED,
      path: '',
      message: `The file list was truncated to maxFiles (${options.maxFiles}) of ${candidates.length} candidate files.`,
    });
  }

  const files = [];
  const unanalyzed = candidates.slice(readable.length);
  const startedAt = options.now();
  let totalChars = 0;
  let complete = readable.length === candidates.length;

  // Everything listed was ignored or fell outside the scope roots. An empty
  // model here means "this tool withheld the whole scope by policy", which is
  // not the same claim as "the project is empty", so coverage cannot be
  // reported as complete and the reason has to be visible.
  if (listed.length > 0 && candidates.length === 0) {
    diagnostics.push({
      code: CODES.NO_FILES_IN_SCOPE,
      path: '',
      message: `${listed.length} file(s) were listed and all of them were ignored or outside the scope roots; nothing was scanned.`,
    });
    complete = false;
  }

  for (let index = 0; index < readable.length; index += 1) {
    const path = readable[index];
    if (options.now() - startedAt > options.timeoutMs) {
      diagnostics.push({ code: CODES.COLLECTION_TIMEOUT, path: '', message: `Collection exceeded timeoutMs (${options.timeoutMs}); ${readable.length - index} file(s) were not read.` });
      complete = false;
      unanalyzed.push(...readable.slice(index));
      break;
    }
    if (totalChars > options.totalCharBudget) {
      diagnostics.push({ code: CODES.FILE_LIMIT_REACHED, path: '', message: `Collection exceeded totalCharBudget (${options.totalCharBudget}); ${readable.length - index} file(s) were not read.` });
      complete = false;
      unanalyzed.push(...readable.slice(index));
      break;
    }

    let text;
    try {
      text = await source.readText(path);
    } catch (error) {
      // A source that refuses a file for its size (the host adapter does this
      // from the size reported at listing time) is a skip, not a read failure.
      const readErrorCode = error !== null && typeof error === 'object' ? error.code : undefined;
      if (readErrorCode === 'FILE_TOO_LARGE') {
        diagnostics.push({ code: CODES.FILE_TOO_LARGE, path, message: 'The source refused to read this file because of its size; it was skipped.' });
      } else {
        diagnostics.push({ code: CODES.SOURCE_READ_FAILED, path, message: 'source.readText() failed for this file; it was skipped.' });
      }
      unanalyzed.push(path);
      continue;
    }
    if (typeof text !== 'string') {
      diagnostics.push({ code: CODES.SOURCE_READ_FAILED, path, message: `source.readText() did not return text, received ${describe(text)}.` });
      unanalyzed.push(path);
      continue;
    }
    if (text.length > options.maxFileChars) {
      diagnostics.push({ code: CODES.FILE_TOO_LARGE, path, message: `The file has ${text.length} characters, more than maxFileChars (${options.maxFileChars}); it was skipped.` });
      unanalyzed.push(path);
      continue;
    }
    totalChars += text.length;
    files.push({ path, text });
  }

  const skippedPaths = new Set();
  for (const entry of unresolved) {
    if (entry.code === CODES.UNSAFE_PATH_SKIPPED || entry.code === CODES.SENSITIVE_PATH_SKIPPED) skippedPaths.add(entry.path);
  }

  unanalyzed.sort(comparePaths);

  return {
    filesListed: listed.length,
    filesScanned: files.length,
    filesSkipped: skippedPaths.size + (candidates.length - files.length),
    complete,
    files,
    unanalyzed,
    unresolved,
    diagnostics,
  };
}

module.exports = { collect };
