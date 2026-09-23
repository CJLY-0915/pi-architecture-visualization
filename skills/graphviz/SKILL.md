---
name: Graphviz
description: Load when a relationship-dense architecture view needs Graphviz DOT source: dependency, cycle, impact, lineage, or flow graphs too dense for C4. A format foundation, not a scenario; it governs layout, not the question.
---

# Graphviz

A **format foundation**, not a scenario. It does not decide what to draw; it decides how the DOT looks once another skill has decided what the view answers. `flow-visualizer`, `dependency-impact-analyzer`, `deployment-topology-analyzer`, `risk-quality-reviewer` and `legacy-system-visualizer` bring the question; you bring the layout. Views that need reusable C4 system/context/container semantics belong to `c4model`.

## Layout

`rankdir=TB` by default. Dense relationship graphs run top-to-bottom; a wide horizontal rank runs off any viewport and reads as blank.

Use `rankdir=LR` only for a short linear lineage, a traffic path, or a service path with few nodes, short labels and no wide clusters. If you reach for `LR` to make a dense graph fit, split the graph instead.

## Node shapes

Keep one mapping across the whole graph so a reader learns the legend once.

| Thing | DOT |
| --- | --- |
| Actor / person | `shape=ellipse` |
| System | `shape=box3d` |
| Container / service | `shape=box` |
| Component / module | `shape=box, style=rounded` |
| Datastore | `shape=cylinder` |
| Queue / topic | `shape=parallelogram` |
| External system | `shape=box, style=dashed` |
| Infrastructure | `shape=component` |

Quote every node id. Model ids contain dots (`module.invoice`) and DOT parses them as two tokens. Use the model id as the DOT id and the node `name` as the label, so the graph stays traceable to `architecture/model.json`.

## Boundaries

Use `subgraph cluster_*` with an explicit `label` for a boundary that is evidenced: a deployment unit, an ownership domain, a scope root, a layer. An unevidenced cluster invents a boundary. State the reason in the cluster label, not in a comment nobody reads.

## Edge labels

The label carries what the model has no field for.

- Relation type, always: `calls`, `publishes`, `reads`, `depends_on`.
- Sync vs async, where it matters.
- Confidence, where it matters: `label="calls (medium)"`.

Style carries status so the picture reads without the label:

- `style=solid` — confirmed
- `style=dashed` — inferred or assumed
- `style=dotted` — unknown

An unlabelled edge is a claim you cannot support. Do not draw a static import as a runtime call.

## Files

- DOT source goes to `architecture/views/<name>.dot`. The DOT file is canonical.
- A rendered SVG or PNG is derived. Regenerate it; never hand-edit it.
- Write the file to disk and reply with its path. Do not inline the DOT source into the conversation.

## Granularity

Prefer several focused graphs over one unreadable one. Split by flow, by layer, by state (`current` vs `target`), or by confidence. One graph per question, each with its own filter stated in the reply.

## Before you draw

Run `architecture_validate` on the model. It checks structure and references — id uniqueness, evidence resolution, dangling endpoints, edge state matching both endpoints — not truth. A valid model can still be wrong, and a beautiful layout can still be a lie.

## Do not

- Do not drop evidence, confidence, or follow-up actions to make the layout prettier.
- Do not deliver one giant graph because splitting felt like extra work.
- Do not invent shapes or clusters the model does not support; unknowns are drawn as unknown.
