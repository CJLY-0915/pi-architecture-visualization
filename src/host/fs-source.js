'use strict';

// Host file source for the read-only collector.
//
// Binds the verified PI-Desktop `pi.fs` surface to the collector's injected
// source contract (listFiles / readText). Verified against the host broker in
// PI-Desktop's app.asar:
//
//   fs.list(pathFromRoot)  -> {name, path, isDirectory, size, mtimeMs}[]
//                             names sorted, one directory at a time, requires fs.read
//   fs.readText(pathFromRoot) -> string, requires fs.read, NO size limit of its own
//   fs.glob(pattern)       -> workspace-relative paths, but capped at 500 matches
//                             in readdir order, so it is deliberately NOT used here
//
// Host behaviours that are silent, and would otherwise corrupt coverage
// reporting, are detected and reported instead of hidden:
//
//   1. `fs.list` stops at 1000 entries per directory without telling the caller.
//      A directory returning that many entries may have been truncated, so a
//      host cap is recorded and coverage is forced incomplete.
//   2. A directory that cannot be listed (protected path, permission, race) is
//      skipped by `fs.list`'s own filtering; a throwing listing is recorded too.
//   3. Host error text is never propagated: the broker's messages can embed
//      absolute paths, so failures are reported with fixed wording.
//
// `fs.readText` loads a whole file with no bound, so sizes reported by `fs.list`
// are used to refuse obviously oversized files before they are read; the collector
// still applies its own post-read character limit to catch growth after listing.
// A refused file is signalled with `error.code === 'FILE_TOO_LARGE'`, which the
// inventory maps to that diagnostic instead of a generic read failure.
//
// Traversal is bounded on every axis: directories visited, entries accepted per
// directory, and depth. Each bound that is hit is recorded, so a bounded scan is
// always visible as incomplete rather than as a small project.

const { compareStrings } = require('../core/compare-strings');

const HOST_LIST_CAP = 1000;
const DEFAULT_MAX_DIRECTORIES = 2000;
const DEFAULT_MAX_DIRECTORY_ENTRIES = 10000;
const DEFAULT_MAX_DIRECTORY_DEPTH = 32;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;

const UNSAFE_CHARACTER_PATTERN = /[:\\\u0000-\u001f\u007f-\u009f]/;


// Mirrors the entry's path rules: control characters and ":" are rejected so a
// host-supplied entry can never become a surprising filename.
function isSafeRelativePath(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  if (UNSAFE_CHARACTER_PATTERN.test(value)) return false;
  if (value.startsWith('/')) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function depthOf(path) {
  return path.split('/').length;
}

// "src" contains "src/a.ts" but never "src2/a.ts".
function isWithinScope(path, roots) {
  return roots.some((root) => root === '.' || path === root || path.startsWith(`${root}/`));
}

// Pruning test for directories: keep only directories that can still lead to a
// scope root, either from above (an ancestor of a root) or from within one.
function canLeadToScope(directory, roots) {
  if (directory === '') return true;
  return roots.some((root) => root === '.'
    || directory === root
    || directory.startsWith(`${root}/`)
    || root.startsWith(`${directory}/`));
}

// Scope roots follow the collector's rules: "." means the whole workspace, and
// any other root is a relative path without traversal. "." must be accepted
// here, otherwise the default scope would enumerate nothing at all.
function isSafeScopeRoot(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  if (value === '.') return true;
  return isSafeRelativePath(value);
}

function createError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
/**
 * Creates a collector source backed by the host `pi.fs` API.
 *
 * Deterministic: directories are walked in sorted order and the returned path
 * list is sorted, so the host's own readdir order cannot reach the model. Bounded:
 * traversal stops at `maxDirectories`, and every stop or possible host truncation
 * is recorded in `limits` rather than silently reducing the file set.
 *
 * @param {{fs: {list: Function, readText: Function}}} pi Host API object.
 * @param {{scopeRoots?: string[], maxDirectories?: number, maxDirectoryEntries?: number, maxDepth?: number, maxFileBytes?: number}} [options]
 * @returns {{source: {listFiles: () => Promise<string[]>, readText: (path: string) => Promise<string>}, limits: Array<{code: string, path: string, message: string}>}}
 */
function createHostSource(pi, options) {
  const settings = options === undefined ? {} : options;
  const scopeRoots = Array.isArray(settings.scopeRoots) && settings.scopeRoots.length > 0
    ? settings.scopeRoots
    : ['.'];
  const maxDirectories = settings.maxDirectories === undefined ? DEFAULT_MAX_DIRECTORIES : settings.maxDirectories;
  const maxDirectoryEntries = settings.maxDirectoryEntries === undefined
    ? DEFAULT_MAX_DIRECTORY_ENTRIES
    : settings.maxDirectoryEntries;
  const maxDepth = settings.maxDepth === undefined ? DEFAULT_MAX_DIRECTORY_DEPTH : settings.maxDepth;
  const maxFileBytes = settings.maxFileBytes === undefined ? DEFAULT_MAX_FILE_BYTES : settings.maxFileBytes;

  const limits = [];
  const sizes = new Map();
  let covered = [];

  function record(code, path, message) {
    limits.push({ code, path, message });
  }

  // Entries the host returned that do not describe a workspace-relative entry.
  // They are reported rather than dropped, so an unexpected host shape cannot
  // quietly shrink the file set.
  function describeEntryProblem(entry) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return 'the entry is not an object';
    if (!isSafeRelativePath(entry.path)) return `the entry path is not a safe workspace-relative path`;
    if (typeof entry.isDirectory !== 'boolean') return 'the entry has no boolean isDirectory field';
    return null;
  }

  async function listDirectory(directory) {
    try {
      return { ok: true, entries: await pi.fs.list(directory) };
    } catch {
      // The host message can embed absolute paths, so it is never propagated.
      return { ok: false, entries: [] };
    }
  }

  async function listFiles() {
    // The host rejects an out-of-tree path, but a scope root is caller input and
    // must never be able to steer traversal, so it is validated here as well.
    const roots = scopeRoots.filter(isSafeScopeRoot);
    if (roots.length === 0) {
      record('source_list_failed', '', 'Every configured scope root was unusable, so no workspace file was enumerated.');
      return [];
    }

    const files = [];
    const queue = [''];
    let visited = 0;

    while (queue.length > 0) {
      const directory = queue.shift();
      if (visited >= maxDirectories) {
        record('file_limit_reached', directory,
          `Traversal stopped after maxDirectories (${maxDirectories}) directories; remaining directories were not enumerated.`);
        break;
      }
      visited += 1;

      const listing = await listDirectory(directory);
      if (!listing.ok) {
        record('source_list_failed', directory,
          'The directory could not be listed; files below it were not enumerated.');
        continue;
      }
      const entries = listing.entries;
      if (!Array.isArray(entries)) {
        record('source_list_failed', directory, 'The host did not return a directory listing; files below it were not enumerated.');
        continue;
      }
      if (entries.length >= HOST_LIST_CAP) {
        record('file_limit_reached', directory,
          `The host returned ${entries.length} entries for this directory, at its own per-directory cap; the listing may be incomplete.`);
      }
      if (entries.length > maxDirectoryEntries) {
        record('file_limit_reached', directory,
          `The directory returned ${entries.length} entries, above maxDirectoryEntries (${maxDirectoryEntries}); the rest were not read.`);
      }

      const ordered = entries.slice(0, maxDirectoryEntries).sort((left, right) => {
        const leftPath = left !== null && typeof left === 'object' ? left.path : '';
        const rightPath = right !== null && typeof right === 'object' ? right.path : '';
        return compareStrings(String(leftPath), String(rightPath));
      });

      for (const entry of ordered) {
        const problem = describeEntryProblem(entry);
        if (problem !== null) {
          record('source_list_failed', directory, `A listed entry was ignored: ${problem}.`);
          continue;
        }
        if (entry.isDirectory) {
          if (depthOf(entry.path) >= maxDepth) {
            record('file_limit_reached', entry.path,
              `Traversal stopped at maxDepth (${maxDepth}); deeper files were not enumerated.`);
            continue;
          }
          if (canLeadToScope(entry.path, roots)) queue.push(entry.path);
          continue;
        }
        if (!isWithinScope(entry.path, roots)) continue;
        files.push(entry.path);
        if (typeof entry.size === 'number' && Number.isFinite(entry.size)) sizes.set(entry.path, entry.size);
      }
    }

    files.sort(compareStrings);
    covered = files;
    return files;
  }

  async function readText(path) {
    const size = sizes.get(path);
    if (typeof size === 'number' && size > maxFileBytes) {
      throw createError('FILE_TOO_LARGE',
        `The file is ${size} bytes, above the ${maxFileBytes} byte pre-read limit.`);
    }
    return pi.fs.readText(path);
  }

  return { source: { listFiles, readText }, limits, get listed() { return covered; } };
}

module.exports = { createHostSource };
