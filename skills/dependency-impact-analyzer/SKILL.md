---
name: Dependency Impact Analyzer
description: Load when the user asks what a change affects, what depends on what, or where coupling and cycles live. Uses architecture_impact model reachability over declared node ids and evidence paths, never runtime failure prediction.
---

# Dependency Impact Analyzer

Answers one question: **what does this change reach, and what does this thing depend on?**

Impact here means **model reachability**, computed by `architecture_impact` over the nodes and edges declared in `architecture/model.json`. It is not a runtime failure prediction. It does not know about load, retries, circuit breakers, backing-up queues, or which deployment is live. Repeat this every time you report a blast radius, so the reader cannot mistake a graph walk for an outage forecast.

## The one rule

Targets are stable node ids or declared evidence file paths. Nothing else.

## Seeding targets

This host has no branch or change-set lookup. `architecture_impact` takes no branch, commit, or PR parameter, and you must never invent one. When the user says "this branch" or "this PR":

1. Read the git summary yourself: `git status --short`, `git diff --name-status --find-renames`, `git log --oneline -8`.
2. Map each changed path to a node id, or to the evidence entries that declare it.
3. Name those ids explicitly, in the report and in the tool call.

A changed path that maps to no node is an unknown, not a silent omission.

## Traversing

- `direction=upstream` — what reaches the target: dependents, callers, consumers.
- `direction=downstream` — what the target reaches: dependencies, callees, stores.
- `direction=both` — the full neighbourhood; use it when the change touches a contract.
- `relationTypes` narrows the walk to specific edge kinds.

`architecture_impact` and `architecture_query` are both bounded by depth, node count and time. When a result reports truncation, the stop reason is part of the answer: it never means "nothing else is affected".

## Edge kinds are different claims

Do not average them into one "depends on".

| Edge | Claim | Proves | Does not prove |
| --- | --- | --- | --- |
| `depends_on` | compile-time coupling | build order, structural dependency | a runtime call |
| `calls` | runtime invocation | an invocation path exists | latency, failure, frequency |
| `reads` / `writes` | data access | the data touches this store | the business action or its defaults |
| `publishes` / `subscribes` | event channel | topic-level coupling | delivery, ordering, durability |
| `contains` | containment | structural nesting | movement or coupling strength |

Report the blast radius per edge kind, not as one number. A change whose only `calls` edges are `inferred` is a different risk from one whose `depends_on` edges are `confirmed`.

## Confirmed vs plausible impact

- **Confirmed impact** — every edge on the path is `confirmed` with resolving `evidenceIds`, and both endpoints resolve.
- **Plausible impact** — the path crosses an `inferred` or `assumed` edge, a `low` or `medium` confidence edge, or a relation the collectors cannot see.

`architecture_collect` sees static imports and string-literal requires, plus manifest dependencies. It does **not** see dynamic `import()` or `require()`, tsconfig path mapping, `exports`/`main` resolution, re-export barrels, multiline TOML dependencies, `project(':core')`, OpenAPI/Swagger, CI workflows, or Terraform. A clean collect is not a clean graph.

## Dependency health

Run `architecture_query` with `mode=cycles` to find circular dependencies. Report cycle length and the edge kinds involved: a `contains` cycle is a modelling error, a `calls` cycle is a design risk. The result is capped by `maxCycles`, so a truncated cycle list is not proof of acyclicity. The `risk` filter is rejected outright rather than ignored; do not request it.

## First artifact

`architecture/views/blast-radius-<change>.dot` — targets, the upstream and downstream sets, edge kind on each label, `inferred` and `unknown` edges dashed. Draw it with `graphviz`. The reply names the target ids, the traversal direction and stop reason, the confirmed set, the plausible set, and the unknowns.

## Do not

- Do not present reachability as failure prediction. Ever.
- Do not infer a change set from a branch name. Read git and name the nodes.
- Do not mix edge kinds without labelling them.
- Do not treat a truncated traversal as an exhaustive one.
 - Do not turn reachability into an availability, ordering, or latency forecast; the model carries no runtime data.
