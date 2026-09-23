---
name: C4 Model
description: C4 format foundation: map model node types and parentId chains onto system landscape, context, container and component views. Load when a scenario skill has chosen C4 as the artifact shape and a model exists to cut.
---

# C4 Model

A format foundation, not a scenario. It never decides *what* to model — `system-modeler`, `deployment-topology-analyzer` or `architecture-communicator` does that. Load it when C4 levels are the chosen shape for the artifact and there is a model to cut.

## Levels

| C4 level | Node types | `parentId` | Content |
| --- | --- | --- | --- |
| L0 System landscape | `system`, `external` | none | every system in scope plus the external systems they touch |
| L1 System context | one `system` in focus, plus `actor` and `external` | none | the focus system, its direct users, its direct dependencies |
| L2 Container | `container`, `datastore` | → the focus `system` | deployable units and stores inside one system, with the technology that runs them |
| L3 Component | `component` | → a `container` | responsibilities inside one container |
| L4 Code | `module` | → a `component` | optional and rarely worth it; dense module maps belong to `graphviz` |

A level is a filter over the model: select the nodes whose `parentId` chain reaches the focus node at the right depth, then the edges between them. `actor` sits beside the system at L0/L1 and never inside a container; `external` sits outside the focus system at every level and is never its child.

One node appears in exactly one parent's diagram. A boundary that genuinely belongs to two containers stays at the higher level with a `depends_on` edge — `parentId` allows one parent only.

## Containment and the validator

C4 levels are nothing but `parentId` chains, so the hierarchy rules are the level rules:

- `parentId` must resolve to a declared node id (`UNKNOWN_PARENT_NODE`) and must not form a cycle (`HIERARCHY_CYCLE`).
- Ids are unique per collection; nodes, edges, evidence and the id-only `views`/`findings`/`decisions`/`migrationSlices`/`unknowns` each have their own namespace.
- Every `evidenceIds` entry resolves to a declared evidence entry; every edge endpoint resolves to a declared node.
- Evidence paths are relative POSIX inside `scope.roots`.
- `status: confirmed` requires at least one evidence entry; a confirmed `runtime` observation requires `runtime`-type evidence.
- An edge's `state` must equal the state of both endpoints.

Use `parentId` for the tree. A `contains` edge is for containment one parent cannot express — a library deployed into two containers. Never assert both for the same pair: two sources of truth for one fact is the bug this model exists to prevent.

## When C4 fits, and when it does not

| Request | Right output |
| --- | --- |
| Explain a system to a new team, review a boundary, onboard, inventory containers with their technology | C4 |
| Dense dependency graph, "what imports what", module map | `graphviz` |
| Follow one request, event or data flow | `flow-visualizer` |
| Risk register, quality or fitness review | `risk-quality-reviewer` |
| Where it runs and how it is released | `deployment-topology-analyzer` |
| Current-vs-target gap, migration slices | `evolution-planner` |
| An editable file the user will keep changing | `drawio` |
| More unknowns than facts | `legacy-system-visualizer` |

C4 breaks when one diagram carries two levels of detail, or when the question is "what happens next" rather than "what is this". Flatten it, split it, or change format.

## Rendering — what the host actually does

- PI-Desktop has **no Structurizr renderer**. Nothing in this plugin lays out a C4 diagram.
- `architecture/views/<name>.structurizr.dsl` is a **text artifact**: a human reads it, or an external Structurizr-compatible tool renders it. Say so when you hand it over.
- The workbench's in-panel export preview is what the user actually sees: an in-memory, read-only text preview of `structurizr`, `c4`, `dot`, `mermaid`, `drawio`, `markdown`, `json`, `svg` and `html`. `c4` is the level-aware one — it takes `{focus, level}`, filters the focus's `parentId` subtree at that depth, nests the elements, maps node types to C4 keywords and keeps `type/status/confidence` plus the model id on every element. `structurizr` stays the flattened variant: it renders nodes and edges only and flattens every node to `softwareSystem`. Neither saves, downloads or writes.
- PNG is explicitly unsupported: no rendering stack exists in the current zero-dependency boundary, and a fake binary is never produced.
- When the user must see the architecture in-panel, emit `.dot` or `.mmd` and route to `graphviz`; when they need real C4 rendering, the DSL goes to an external tool.

## Working order

1. Start from `architecture/model.json`. With no model, build one with `system-modeler` first — C4 levels cannot be derived from an unshaped pile of files.
2. Choose the level that answers the question and cut exactly one diagram for it. In the panel, pick format `C4 层级（Structurizr DSL）` and set the focus node id plus L1/L2/L3; from the model side, the same cut is a depth filter over `parentId`.
3. Derive the view from `nodes` and `edges`, keeping `status` and `confidence` on the labels: an inferred container stays labelled inferred.
4. Write `architecture/views/<name>.structurizr.dsl` beside the model, never instead of it.
5. Run `architecture_validate {path}` and clear every diagnostic before calling the view done.

## Do not

- Do not hand-draw a C4 view with no model behind it.
- Do not flatten L1–L3 into one diagram to look complete.
- Do not raise a node's confidence to make the diagram read better.
- Do not promise a rendered C4 diagram the host cannot produce.
