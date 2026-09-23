'use strict';

// Deterministic identifier helpers shared by the collector adapters.
// Ids are derived only from stable inputs (workspace-relative path, dependency
// name, relation kind), never from counters or timestamps, so the same source
// tree always yields the same model. Every namespace has its own prefix, which
// keeps node ids unique across adapters.

function fileNodeId(path) {
  return `file:${path}`;
}

function externalNodeId(name) {
  return `external:${name}`;
}

function containerNodeId(kind, name) {
  return `container:${kind}:${name}`;
}

function edgeId(sourceId, targetId, type) {
  return `edge:${sourceId}|${targetId}|${type}`;
}

// Evidence identity is (path, line, type): the same reference produced by two
// adapters collapses into one declared evidence entry. A missing line is
// encoded as 0 so that ids stay unique and stable.
function evidenceId(path, line, type) {
  return `ev:${path}#${line === undefined ? 0 : line}:${type}`;
}

module.exports = { fileNodeId, externalNodeId, containerNodeId, edgeId, evidenceId };
