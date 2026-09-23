---
name: Architecture Explore
description: Router for architecture questions: what this system is, how something flows, what a change affects, where it runs, how it should evolve, whether it is risky, or whether docs are stale. Picks a scenario skill; ships a first artifact now.
---

# Architecture Explore

Route a broad architecture request to one scenario skill, then **produce the first artifact in the same turn**. Routing is a private decision — the user sees the artifact, not the decision tree.

## The one rule

A first architecture request ends with a file on disk that answers the question at a coarse grain. If you catch yourself writing a plan about the plan, stop and write the map instead.

When the request is broad or vague — "看看这个项目的架构", "map this repo", no noun, no scope — the default is:

1. `architecture/model.json` at L1/L2 grain, 10–30 nodes, every node carrying `status` and `confidence`.
2. One view: `architecture/views/current-state.dot`.
3. A short reply naming what is confirmed, what is inferred, and the top three unknowns.

That is the entire first turn. Finer grains, flows, and target-state work are follow-up requests, not prerequisites.

## Routing

Pick the row matching the user's decision, not the format they happened to name. One primary skill; add a supporting skill only when the primary cannot finish without it.

| The user wants to… | Primary | First artifact |
| --- | --- | --- |
| Know what this system/repo is and where its boundaries are | `system-modeler` | `architecture/model.json`, L1/L2, 10–30 nodes |
| Follow one business path, call chain, event, or data flow | `flow-visualizer` | one `.dot`/`.mmd` for the single most decision-relevant path, unknowns drawn as unknown |
| Know what a change affects | `dependency-impact-analyzer` | blast radius from explicit node IDs, upstream and downstream |
| Know where it runs and how it is released | `deployment-topology-analyzer` | container/service inventory from compose, k8s, or IaC manifests |
| Decide how it should change | `evolution-planner` | current-vs-target gap table; the target comes from the user and is never invented |
| Judge whether it is risky or fit for purpose | `risk-quality-reviewer` | ranked risks, each tied to a file path |
| Understand or modernize a poorly documented system | `legacy-system-visualizer` | unknowns-first inventory: what is known, what is not, who might know |
| Explain it to a specific audience | `architecture-communicator` | one view cut for that audience's decision |
| Check whether the model or diagrams are still true | `architecture-health` | freshness and traceability findings against `architecture/model.json` |

`c4model` and `graphviz` are format foundations for the artifact, not scenarios. `drawio` applies only to an explicit editable-delivery request.

If the request names a PR, branch, commit range, or "this change", read the change summary first (`git status --short`, `git diff --name-status --find-renames`, `git log --oneline -8`) and route from what it touches: dependencies, contracts, modules, tests, or data stores → `dependency-impact-analyzer`; diagrams, evidence, or the model itself → `architecture-health`; ADRs, risk controls, or release-critical paths → `risk-quality-reviewer`; migration slices or target-state work → `evolution-planner`.

## Evidence

- `high` — code, config, schema, IaC, runtime data, or an authoritative doc states it directly.
- `medium` — several partial signals agree, none states it directly.
- `low` — naming, folder layout, or convention.
- `unknown` — deliberately recorded as a gap to investigate.

A field, table, or enum proves data shape, not the business action that uses it. A form or route proves an affordance, not the backend effect. A fixture or seed proves example data, not production defaults. A static import proves a compile-time edge, not a runtime call. When the handler, job, trigger, or trace is missing, split the confirmed structure from the inferred mechanism and label both.

- `architecture_collect` is an evidence cross-check, not a model generator. The host tool returns a bounded summary — at most 150 nodes, 300 edges and 100 entries per remaining list, capped at 240 KiB, with `truncated` recording exactly what was omitted — and it writes nothing. Use it to confirm a dependency edge you are about to assert. Then run `architecture_validate` on whatever you wrote — it checks structure and references, not truth, so a valid model can still be wrong.

## Do not

- Do not ask the user to pick a diagram format before there is anything to draw.
- Do not read the routing options back to the user.
- Do not defer the first artifact to go read more documentation. This skill is self-contained; the model contract is `schemas/architecture-model.schema.json` and it is enforced by `architecture_validate`, not by prose.
- Do not emit `architecture-plan.md`, `scenario-route.md`, `architecture-evidence-plan.md`, or `artifact-summary.md` unless the user asked for a plan or the work will span sessions. They are not the first artifact.
- Do not raise a node to `confirmed` without a cited evidence path.
- Do not draw a happy path across a gap. Draw the gap.

## When to ask

Ask exactly one question, and only when the answer changes the artifact: the scope boundary, which of two systems, or the target state for an evolution request. Never ask about format, skill, grain, or file name. If you must ask, ship the coarse map first and refine after the answer.

## Done

The turn ends when a file exists that answers the question at coarse grain, the reply separates confirmed from inferred, and the top unknowns are named. Anything finer is a follow-up.
