---
name: Legacy System Visualizer
description: Use when understanding, mapping, stabilizing or modernizing a poorly documented legacy system with sparse evidence, unknown owners, hidden dependencies, batch jobs or data coupling. Ships an unknowns-first inventory before any proposal.
---

# Legacy System Visualizer

Legacy work differs from ordinary modeling in one respect: sparse evidence, undocumented runtime behavior and human-only knowledge are the subject of the analysis, not an obstacle to it.

The first artifact is an unknowns-first inventory. Do not open with a rewrite proposal.

## First artifact

One file, same turn: `architecture/legacy-inventory.md` — what is observed, at what confidence, and what is unknown — backed by `architecture/model.json` for the facts solid enough to record. When nothing is solid, the inventory still ships and `unknowns` carries the load.

Unknowns are first-class output. An unknown with a named owner and a validation step is worth more than a guess drawn as a box.

## What to inventory

| Surface | What counts as observed | Where it hides |
| --- | --- | --- |
| Modules and boundaries | entry points, package or namespace layout, shared libraries | barrels, generated aggregators, code kept alive only by config |
| Data | stores, schemas, migrations, reports, exports, replication | views, triggers, stored procedures, ETL, direct writers outside the app |
| Jobs | schedulers, cron, queue consumers, retry loops | scheduler tables, external orchestrators, ops runbooks |
| Manual operations | one-off scripts, admin consoles, DBA procedures | personal scripts, wiki pages, ticket history |
| External interfaces | inbound and outbound calls, file drops, feeds | undocumented partners, hardcoded hosts |
| Ownership | who can answer what | people, not files; record the role as a gap when absent |

Label every line with `confidence` and at least one evidence path. Rumour and tribal knowledge are recorded as `low` or `unknown` with a concrete validation step, never as `confirmed`.

## Why a heuristic collector is weak here

`architecture_collect` is an evidence cross-check, not a discovery engine, and a legacy system is its worst case:

| Collector | Sees | Misses |
| --- | --- | --- |
| js-ts | static import/export and `require`/`import` specifiers, bare package names in package.json | dynamic `import()`/`require()`, tsconfig path mapping, `exports`/`main` resolution, re-export barrels |
| manifests | single-line dependencies in package.json, requirements.txt, pyproject, go.mod, pom.xml, build.gradle | multiline or table TOML dependencies, `project(':core')`, other package managers |
| infra | Compose top-level services and `depends_on`, Kubernetes kind and `metadata.name` | OpenAPI, CI workflows, Terraform, other YAML |

It returns a bounded summary only — counts and unresolved items — and writes nothing; use it to confirm a dependency you are about to assert, never to enumerate the system.

Read by hand, because no collector finds these:

- Runtime-only dispatch: reflection, service locators, plugin registries, string-keyed handler maps, dependency-injection containers.
- Generated code and build output. The generator and its configuration are the fact; the output is a consequence.
- Hidden runtime configuration: environment variables, external config services, feature flags, profiles, registry lookups.
- Undocumented batch work: cron, Windows tasks, scheduler tables, orchestrator DAGs, jobs that operations triggers by hand.
- Code deployed but unreachable, and code reachable but not in this repository.

None of these is a compile-time edge, so a static import proves nothing about them.

## Risk clusters before proposals

Group findings before proposing anything. A cluster is a set of facts that would each be survivable alone.

| Cluster | Signal | What it blocks |
| --- | --- | --- |
| Critical path without tests | a capability with no test evidence and high fan-in | any refactor, any deploy |
| Shared mutable data | several writers to one store, no declared owner | extraction, splitting, partitioning |
| Human-only knowledge | a job or interface one person can explain | any schedule change, any incident |
| Undocumented external contract | a partner call with no schema or document | rewriting the caller |
| Fragile script chain | scripts calling scripts across environments | any migration step that depends on them |
| Unknown ownership | no team, no on-call, no runbook | any decision that needs an approval |

Rank clusters by what a change would touch, not by how ugly the code is. `dependency-impact-analyzer` supplies the reachability; this skill decides what that reachability means.

## Stabilization and modernization slices

Propose slices only after the inventory and the clusters exist. Each slice binds five things; a slice missing one is not a slice.

| Field | Requirement |
| --- | --- |
| Capability | the business behavior that must keep working, in business words |
| Data boundary | the stores it reads and writes, owner named or declared unknown |
| Risk | the cluster it sits in and what breaks if the slice is wrong |
| Validation signal | an observable check that behaviour is unchanged — test, report, reconciliation, canary |
| Rollback boundary | how the previous behaviour is restored and who can trigger it |

Sequence slices so each leaves the system observable. Prefer a strangler seam that can carry traffic before anything is deleted. Record slices in `migrationSlices` by id; keep the reasoning in the slice document, not in the model.

## Model discipline

- `status: "confirmed"` requires at least one evidence entry; the validator rejects an unproven confirmed node or edge.
- An edge's `state` must equal the state of both endpoints. A current-state edge cannot point at a target-state node.
- `coverage.complete: false` is the honest value for a partial scan; unresolved items belong in `unknowns` or as inferred/unknown facts.
- Use `system-modeler` for structure, `flow-visualizer` for one critical path, `dependency-impact-analyzer` for reachability, `evolution-planner` for target-state sequencing, `risk-quality-reviewer` for ranked risk.

## Do not

- Do not draw a happy path across a gap. Draw the gap.
- Do not treat folder structure as a business boundary without evidence.
- Do not raise a fact to `confirmed` because it is widely believed.
- Do not open with a rewrite, a platform change or a framework migration.
