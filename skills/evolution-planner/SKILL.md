---
name: Evolution Planner
description: Load when the user asks how the architecture should change: current-versus-target gap analysis, migration slices, sequencing, architecture decisions and tradeoffs, or a modernization roadmap.
---

# Evolution Planner

Answer one question: **what changes, in what order, and how will we know it worked.** Current state comes from the model. Target state comes from the user.

## The one question

If no target is given, ask for it — that is the only question worth asking, because the artifact changes with the answer. Proceed on everything else. If you must ask, ship the current-state gap skeleton first and fill the target column after the reply.

Never invent a target. "Microservices", "event-driven" and "cloud native" are not targets; a named set of nodes, relations and constraints is.

## First artifact

`architecture/current-vs-target.md` — one row per gap: capability, current evidence, target statement, who stated it, confidence, and the slice that closes it. Add `architecture/views/current-vs-target.dot` when the relationship between the two states is the question.

## Keep the states apart

| Claim | `state` |
| --- | --- |
| What the model shows today | `current` |
| What the user wants | `target` |
| What you propose as the way to get there | `target`, marked as a proposal in the artifact |
| What was observed running | `runtime` |

An edge's `state` must equal the state of both endpoints (`src/core/validation.js`), so a current-to-target edge is rejected. Do not draw one. Model today's graph among `current` nodes, the intended graph among `target` nodes, and carry the difference as gaps, findings and migration slices — never as an edge that pretends the change already exists.

## Decisions

`decisions` is an id-only collection in v1: the model carries the id, not the substance. Write the record as markdown beside the model (`architecture/decisions/<id>.md`) with context, options, the chosen direction, rejected alternatives, consequences and reversibility, and reference that file from the model entry. A decision id with no companion document is a dangling claim.

## Migration slices

A slice is a shippable unit with a boundary, not a step in a list. Each slice records:

| Field | Meaning |
| --- | --- |
| scope | the node and edge ids it touches |
| entry condition | what must already be true |
| validation signal | the test, query or metric that proves it worked |
| rollback boundary | the point after which rollback stops being cheap |
| evidence | paths supporting the slice's claims |

Sequence by dependency, then risk, then reversibility. A slice with no validation signal is a hope; a slice with no rollback boundary is a commitment nobody priced.

## Compare and snapshots

`architecture_compare {beforePath, afterPath}` diffs two model files by stable identity and reports semantic differences plus evidence freshness signals. It never infers Git state. Two uses:

- **current vs target** — keep the target as its own model file whose nodes carry `state: target`, then diff it against the current model.
- **snapshot vs snapshot** — plan the immutable copy with `architecture_snapshot_plan {path}` (content-addressed, target always `architecture/snapshots/<sha256>.json`, and it never writes — you write the file yourself), then compare two snapshots to see what actually moved.

Branch and change-set lookup is unavailable and never inferred: supply explicit model paths and explicit targets.

## Do not

- Do not present desired architecture as current evidence.
- Do not merge target nodes into the current graph to make the picture complete.
- Do not sequence slices without naming a validation signal for each one.
- Do not record a decision without a companion document.
- Do not claim a migration happened because a branch exists.

## Done

The turn ends when `architecture/current-vs-target.md` exists, every gap names its evidence and its slice, and the reply separates what is confirmed today, what the user asked for, and what remains an assumption.
