---
name: Risk Quality Reviewer
description: Load when the user asks whether the architecture is fit for purpose: ranked risks, quality attributes, technical debt, review findings, or remediation priorities tied to evidence and acceptance criteria.
---

# Risk Quality Reviewer

Answer one question: **is this architecture good enough for what it is for, and what gets fixed first.** A first architecture request still ends with a file on disk in the same turn.

## First artifact

`architecture/risk-register.md` — one row per risk, ranked, each tied to an evidence path. Add `architecture/views/risk-map.dot` when the risk network itself is the question.

## Boundary

This skill reviews a system that is already described; it does not discover one. When the structure itself is unknown, start with `system-modeler`, or with `flow-visualizer` / `deployment-topology-analyzer` for a focused pass, and return with a model to review.
## A risk is a claim with teeth

Every entry carries all eight fields. Missing one means it is not a risk yet.

| Field | Content |
| --- | --- |
| id | stable id, also recorded in the model's `findings` |
| statement | what could go wrong, in one sentence |
| evidence | path plus line, or an explicit assumption |
| goal | the architecture goal it threatens |
| confidence | high/medium/low/unknown, per the evidence scale |
| likelihood | how often, with the basis for the estimate |
| impact | what breaks, and for whom |
| acceptance | the check that proves it fixed or absent |

A risk without an acceptance criterion is an opinion. Keep likelihood, impact and confidence separate: a low-confidence high-impact risk is a research task, not a fire.

## Ranking remediation

Order by blast radius, then business impact, then reversibility, then effort:

1. `architecture_impact {path, targets, direction}` for model reachability — upstream, downstream or both. It reports what the model connects, never runtime failure probability.
2. Business impact from the paths the system exists to serve. When the target is a business application, name the business path each risk threatens: the same coupling defect on a checkout path outranks one on an admin screen.
3. Reversibility — cheap to undo can wait.
4. Effort last, and only to break ties.

## Quality attributes and technical debt

Assess the attributes the stated goals actually name — performance, availability, reliability, scalability, maintainability, testability, security, observability — and say which stimulus, response and measurement you used for each. A generic checklist is not an assessment.

Technical debt entries are risks with a slow clock. Name the interest (what every future change pays) and the principal (what retiring it costs). Debt that no goal cares about is a note, not a register row.

## Where risk reasoning happens

The `risk` filter on `architecture_query` is **rejected by the host**, not silently ignored: the tool schema is closed, so an unknown filter field fails argument validation instead of returning an empty result. Risk ranking is this skill's own output.

Use the query tool for what it does support — `mode:"filter"` with `types`, `statuses`, `confidences`, `evidenceTypes`, `relationTypes`; `mode:"neighbours"`, `"paths"` and `"cycles"` for structure — and do the judgement here. Results are bounded: a truncated result states its stop reason and must not be read as "no more relations".

## What architecture_health gives you

`architecture_health {path}` reports contract violations and model-declared gaps: unresolved references, out-of-scope evidence, unproven confirmed facts, edge state mismatches, hierarchy cycles, and the model's own `unknowns`. It always reports `sourceContentVerified: false` with freshness unknown, and it never reads source content.

Those findings are inputs, not the answer. A model can be perfectly valid and still describe a system that fails its goals; a register built only from health output is a lint report. Read the source for the risks the model cannot see.

## Evidence

- `high` — code, config, schema, IaC, runtime data, or an authoritative doc states it directly.
- `medium` — several partial signals agree, none states it directly.
- `low` — naming, folder layout, or convention.
- `unknown` — a deliberately recorded gap, with the check that would settle it.

## Do not

- Do not label something a risk until either evidence or a stated assumption backs it.
- Do not attach a severity without an acceptance criterion.
- Do not run a generic checklist; tie each finding to a stated goal.
- Do not treat model reachability as failure prediction.
- Do not present a valid model as a healthy system.

## Done

The turn ends when `architecture/risk-register.md` exists with ranked rows, the reply leads with the top finding and its evidence, and every unproven item is named as a gap with its next check.
