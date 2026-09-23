---
name: System Modeler
description: Build an evidence-backed current-state model of a repo, system or service: architecture/model.json at L1/L2 grain, 10-30 nodes, stable ids, honest status/confidence. Load when the user asks what this system is or where its boundaries lie.
---

# System Modeler

Answer "what is this system and where are its boundaries?" with `architecture/model.json` — the evidence-backed current-state model every later skill reads, and `explore`'s default landing point.

## The default first turn

1. `architecture/model.json`, L1/L2 grain, 10–30 nodes, every node carrying `state`, `status`, `confidence`.
2. One view: `architecture/views/current-state.dot`.
3. A reply separating confirmed from inferred and naming the top three unknowns.

Finer grains, flows and target-state work are follow-up requests.

## Choosing nodes

Not a file inventory: a 30 000-file repository still gets 10–30 nodes. Nodes come from boundaries — `system` (the thing itself), `container` (deployable/runnable units), `component`/`module` (a responsibility or package inside one, only when evidenced), `datastore` (databases, queues, buckets, caches), `external` (third-party systems), `actor` (roles outside the system). Pick by boundary, not file count: entry points, deployable units, integrations, data stores, contract-owning modules. Stop when the next node would not change a decision.

## Stable ids

Ids join models across `architecture_impact`, `architecture_compare` and snapshots; they survive renames and diffs.

- `<type>:<boundary-name>`: `container:api`, `module:billing`, `datastore:orders-db`, `external:stripe`. Name the boundary, not the file — no paths, hashes, counters or indices.
- Same shape the collectors emit (`file:<path>`, `external:<name>`, `container:<kind>:<name>`), so collect-derived and hand-written nodes coexist and compare.
- Edge `edge:<source>|<target>|<type>`; evidence `ev:<path>#<line>:<type>`, line omitted when file-wide. A renamed boundary keeps its id and updates `name`; a new boundary gets a new id.

## state, status, confidence

First pass is `state: current`; `target` and `runtime` are separate models. An edge's `state` must equal both endpoints', so a current-state edge cannot point at a target-state node.

| status | Earn it with | Typical first pass |
| --- | --- | --- |
| `confirmed` | one or more `evidenceIds` resolving to declared evidence | manifests, entry points, deployables |
| `inferred` | several partial signals agree, none states it directly | structure, call direction |
| `assumed` | a convention that keeps the map readable | module boundaries, ownership |
| `unknown` | a gap you deliberately record | missing docs, unreadable areas |

Most first-pass nodes are `inferred` or `assumed`; that is the honest answer, not a failure. Confidence: `high` = stated directly by code, config, schema, IaC, runtime data or an authoritative doc; `medium` = several partial signals; `low` = naming or folder layout; `unknown` = recorded gap. The validator rejects `confirmed` without evidence and confirmed `runtime` without `runtime` evidence.

## The minimum edge set

`depends_on` when a manifest or static import states the dependency; `calls` when a handler, job or route shows the call; `reads`/`writes` when the accessing code is evidenced, not just the schema; `publishes`/`subscribes` when producer and consumer are both named; `contains` for structural containment, though `parentId` usually says it better. Edges carry `state`, `status`, `confidence` and `evidenceIds` like nodes. Stop when every node's boundary relations are present and no further edge changes a conclusion; imports between files inside one container are not edges at this grain.

## Artifacts

- `architecture/model.json` — the fact source: nodes, edges, evidence, and the id-only `views`/`findings`/`decisions`/`migrationSlices`/`unknowns`.
- `architecture/views/` — derived `.dot`, `.mmd`, `.structurizr.dsl`, one per audience decision, never a second source of truth.
- `architecture/snapshots/<sha256>.json` — content-addressed; `architecture_snapshot_plan` plans one and never writes.

## Tools

- `architecture_collect` — cross-check an edge before asserting it. Returns a bounded summary (counts, up to 150 nodes and 300 edges, `unresolved`, `truncated`); the full model never leaves its process; writes nothing. It reads static imports, string-literal `require()`/`import()`, `package.json` names, compose `depends_on` and Kubernetes `kind`/`metadata.name` — not dynamic `import()`, tsconfig paths, re-export barrels, OpenAPI, CI or Terraform, which stay `inferred` until you read them.
- `architecture_validate {path}` — the gate before claiming done. Structure and references only: it does not read source content and does not confirm truth.
- `architecture_query`, `architecture_impact`, `architecture_compare`, `architecture_snapshot_plan` and `architecture_health` are read-only and bounded: none infers Git state, none writes, and a truncated result is never read as "no more relations".

## Worked shape

Minimal but valid. Pattern-match it; do not copy the ids.

```json
{
  "schemaVersion": 1,
  "project": { "id": "orders" },
  "scope": { "roots": ["."] },
  "sourceRevision": null,
  "generatedAt": "2026-01-15T09:30:00Z",
  "coverage": { "filesScanned": 412, "complete": false },
  "nodes": [
    { "id": "system:orders", "name": "Orders", "type": "system", "state": "current", "status": "confirmed", "confidence": "high", "evidenceIds": ["ev:pkg"] },
    { "id": "container:api", "name": "API", "type": "container", "parentId": "system:orders", "state": "current", "status": "inferred", "confidence": "medium", "evidenceIds": ["ev:main"] },
    { "id": "datastore:orders-db", "name": "Orders DB", "type": "datastore", "parentId": "system:orders", "state": "current", "status": "assumed", "confidence": "low", "evidenceIds": [] }
  ],
  "edges": [
    { "id": "edge:container:api|datastore:orders-db|writes", "source": "container:api", "target": "datastore:orders-db", "type": "writes", "state": "current", "status": "inferred", "confidence": "medium", "evidenceIds": [] }
  ],
  "evidence": [
    { "id": "ev:pkg", "path": "package.json", "type": "config" },
    { "id": "ev:main", "path": "services/api/main.ts", "type": "code", "line": 1 }
  ],
  "views": [], "findings": [], "decisions": [], "migrationSlices": [], "unknowns": []
}
```

`parentId` resolves and never cycles, `evidenceIds` resolve, evidence paths are relative POSIX inside `scope.roots`, and the edge's `state` equals both endpoints'.

## Done

The model validates, one view exists, and the reply separates confirmed from inferred and names the top unknowns. Never enumerate files as nodes, never mark `confirmed` without cited evidence, never mix states across one edge, never draw a happy path across a gap.
