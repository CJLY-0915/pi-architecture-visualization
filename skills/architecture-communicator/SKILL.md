---
name: Architecture Communicator
description: Use when an evidence-backed architecture model must be explained to a specific audience, such as executives, product, engineering, operations, security or new joiners, who must make a decision. Ships one to three focused views.
---

# Architecture Communicator

This skill explains an architecture that already exists in the model. It does not discover one, and it never invents a fact to fill a hole.

Decide the audience and their decision before choosing a view. The view is a consequence of that decision, not a starting point.

## First artifact

One file, same turn: the view plus its reading notes — `architecture/views/<audience>.dot` (or `.mmd`) and `architecture/communication-notes.md`. When no model exists yet, build the coarse map with `system-modeler` first and ship that; a communication view is never the first artifact of a project.

## Sequence

1. Audience: who reads it and what they are able to act on.
2. Decision: the one choice they must make after reading, written as a sentence. No decision, no view.
3. Source: the model or a scenario artifact derived from it. Name the path.
4. Views: one to three. Remove unrelated detail instead of shrinking an overloaded diagram.
5. Translation: audience labels, stable ids kept.
6. Caveats: what the view does not show, and why.

## One to three views

| Audience | Decision they usually own | View that answers it |
| --- | --- | --- |
| Executive or business | fund, defer, cancel | capability/context view, one decision per visual |
| Product | scope and sequencing | capability map with the affected slice marked |
| Engineering | build, refactor, cut a seam | container/module/flow view with evidence paths |
| Operations | run, roll back, alert | deployment/runtime view with failure boundaries |
| Security | trust boundaries and data exposure | runtime view with trust boundaries and external interfaces |
| New joiner | where to start reading | progressive map: context, one key flow, ownership |

Three views is the ceiling for one audience. When two audiences need different pictures, cut two views; do not average them into one.

## Translating labels without laundering caveats

| Model fact | Audience label | Must still say |
| --- | --- | --- |
| node `container`, status `confirmed` | "the billing service" | which file proves it exists |
| node status `inferred`, confidence `medium` | "probably the billing service" | that it is inferred, and from what |
| edge type `calls`, confidence `low` | "talks to payments" | that the runtime call is not proven |
| an entry in `unknowns` | "not yet mapped" | what evidence would settle it |
| `coverage.complete: false` | "partial picture" | which part was not scanned |

A friendlier label may change vocabulary. It may not drop `status`, `confidence`, a coverage limit, or the evidence path that lets a reader check the claim. Keep node and edge ids in the artifact — in a label, tooltip, caption or side table — so the audience can drill back into `architecture/model.json`.

## Fidelity rules

- The model stays canonical. A communication view is derived; it never becomes a second source of truth.
- Preserve stable ids and evidence references. A view that cannot be traced back is decoration.
- Keep `state` honest. Current, target and runtime observations are never mixed in one node or one view without saying so.
- Reading order belongs in the artifact: what to look at first, what second, what to ignore.
- State the caveats in the file, not only in the reply. Readers forward the file, not the conversation.
- Never present a derived view as evidence. It is a rendering of evidence.

## Do not

- Do not put every audience in one diagram because it is cheaper.
- Do not simplify away a material risk, assumption or unknown.
- Do not invent a target state to make the picture cleaner; a target comes from the user.
- Do not ask the user to pick a format before there is a view to deliver.
- Do not use this skill to substitute for missing evidence; model the system first.
