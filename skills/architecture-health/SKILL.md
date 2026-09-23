---
name: Architecture Health
description: Use when checking whether architecture/model.json and its derived diagrams, reports or exports are still true, internally consistent and honest about their gaps. Runs architecture_health, compare and snapshot_plan.
---

# Architecture Health

The canonical model is `architecture/model.json`. Diagrams, reports and exports are derived artifacts: they can be regenerated, they can be wrong, and they are never the thing being checked.

Health answers one question — is the model internally consistent and honest about its gaps? It never answers "is this what the code does now", because that needs a source read this plugin does not perform.

## Running it

`architecture_health { "path": "architecture/model.json" }` — exactly one workspace-relative model path. Read-only: it writes nothing and reads the model document only, no source files, no artifacts, no clock. It is the one reader that still reports validator findings for a document that fails the contract, so a broken model produces a diagnosis instead of a refusal.

It runs `validateModel` first, so the structural rules keep exactly one source of truth in `src/core/validation.js`. Health then adds the facts the model declares about itself. `ok` mirrors validation validity, and a valid model still reports its gaps as findings.

## Reading the findings

| Category | Severity | What it means |
| --- | --- | --- |
| `contract` | error | the document breaks the v1 contract: missing fields, bad enum values, malformed ids, evidence paths outside scope |
| `conflicts` | error | the document contradicts itself: dangling edge endpoints, unknown evidence references, confirmed facts with no evidence, an edge state that does not match both endpoints, unknown parent, hierarchy cycle, duplicate id |
| `coverage` | warning | `coverage.complete` is false — the scan was partial, so the model is not a complete picture |
| `unknowns` | info | an entry in `unknowns` is still unresolved; reported, not resolved |
| `evidence` | warning | a node or edge declares no `evidenceIds` at all |
| `confidence` | warning | a node or edge is held at `low` or `unknown` confidence |

Read `counts.byCategory` before the list. Errors are contract violations or self-contradiction and must be fixed in the model. Warnings and infos are the honest gap surface — and an empty gap surface on a real, aging system is itself a finding worth questioning.

## Freshness limits, stated every time

The result always carries:

```
sourceContentVerified: false
evidenceFreshness: "unknown"
artifactFreshness: "unknown"
```

with reasons, and this holds even when the model declares `sourceRevision`, `generatedAt`, a snapshot fingerprint or suspiciously old evidence. The tool never reads source content, so it cannot judge freshness and does not guess. Treat each of these as "not established", never as "fresh".

So "healthy" means internally consistent and honest about its gaps. It never means verified against current code. Put that sentence in the report, in those words, so nobody downstream upgrades the claim.

## Keeping the architecture alive

`architecture_compare { "beforePath": ..., "afterPath": ... }` diffs two model snapshots by stable identity, reports semantic differences and explicit evidence freshness signals, never infers Git state, and always returns `sourceContentVerified: false`. Use it when a change may have moved the architecture, or when a diagram may have drifted from the model.

`architecture_snapshot_plan { "path": ... }` plans a content-addressed snapshot and never writes. The target is always `architecture/snapshots/<sha256>.json`. Canonicalization is deterministic, so the same semantic model yields the same fingerprint — reordering collections or reformatting JSON does not create a new snapshot, which makes the fingerprint usable as a change signal. Publishing a snapshot is deliberately not implemented: the host offers no atomic publish primitive, and a half-written snapshot is worse than none. Plan locally; publish by hand if the project needs it.

## A repeatable local check

1. Validate — `architecture_validate architecture/model.json`. Fix contract errors first.
2. Health — `architecture_health architecture/model.json`. Record the counts and every error.
3. Compare against the previous model with `architecture_compare`; treat added, removed and changed facts as review items, not noise.
4. Plan a snapshot with `architecture_snapshot_plan`; if the fingerprint changed, decide whether the semantic change was intended.
5. Re-derive the artifacts from the same model — DOT, Mermaid, Structurizr DSL, Draw.io XML — so no diagram keeps a fact the model dropped.
6. Report what is consistent, what is a declared gap, what is unverifiable, and which single check to re-run next.

Steps 1–4 are deterministic and read-only: same input, same output, no hidden manual step, no clock, no network. That is what makes the check repeatable in CI or by hand.

## Do not

- Do not mark a diagram current because the model is valid. Validity is not freshness.
- Do not treat a missing `evidenceIds` as proof a fact is wrong; it is a finding.
- Do not invent Git state, a branch or a change set to explain a difference.
- Do not silence a finding by editing the model to agree with the diagram.
- Do not use this skill to build the first model unless validation is the actual request.
