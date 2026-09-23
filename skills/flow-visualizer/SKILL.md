---
name: Flow Visualizer
description: Load when the user wants to follow one path through a system: a business action, service call chain, event stream, batch job, data lineage, or state transition. Ships one DOT path with sync/async and failure semantics on every edge.
---

# Flow Visualizer

Answers one question: **how does one thing move through this system?** A request, a call chain, an event, a batch run, a data object, a state transition. You are not mapping the system; you are tracing one path through it.

## The one rule

One path per artifact. Pick the single most decision-relevant path and finish it in this turn. If the user named three flows, ship the one that answers the decision and list the others as follow-ups. Do not draw the whole system and label it a flow.

## Classify first

Decide what kind of movement this is before choosing a representation. The kind decides which edge types are legal and what "labelled" has to mean.

| Flow kind | Model edge types | Sync or async | The artifact must show |
| --- | --- | --- | --- |
| Business / process | `calls`, `depends_on` | usually sync | actor, action, outcome; approvals and manual steps |
| Service call | `calls` | sync | request path, timeout, retry, failure branch |
| Event | `publishes`, `subscribes` | async | producer, channel, consumer, ordering and loss semantics |
| Batch | `calls`, `writes` | scheduled | trigger, window, idempotency, partial failure |
| Data lineage | `reads`, `writes` | either | store, owner, retention, sensitivity when evidenced |
| State transition | `calls` between state-bearing nodes | either | the transition trigger, not the field that stores the state |

`contains` is containment, not movement. Never use it as a flow edge.

## Workflow

1. Name the trigger and the outcome: a user action, a route, an event, a schedule, a data production point. If either end is unevidenced, that is the first finding, not a footnote.
2. Classify the flow with the table above.
3. Load `architecture/model.json`. If it does not exist, the contract is `schemas/architecture-model.schema.json` and `system-modeler` builds the model first.
4. Walk the path with `architecture_query` (`mode=paths`, `from`, `to`), or hop by hop with `mode=neighbours`. A truncated result states its stop reason; it never means "no further relations".
5. Use `architecture_collect` to confirm an edge you are about to assert. It returns a bounded summary of counts and unresolved items, not the model.
6. Draw the confirmed path, then the branches: retries, timeouts, dead letters, manual steps, permission checks.
7. Label every edge with relation type, sync/async, and failure semantics. An unlabelled edge is a claim you cannot support.
8. Draw the gap.

## Evidence limits

These are the traps that turn structure into a false story:

- A field, table, or enum proves data shape, not the business action that uses it.
- A form or route proves an affordance, not the backend effect.
- A fixture or seed proves example data, not production defaults.
- A static import proves a compile-time edge, not a runtime call.

Split the confirmed structure from the inferred mechanism and label both. `calls` is a runtime claim: raise it to `confirmed` only with handler, job, trigger, callback, trace, or test evidence. Otherwise draw it dashed and call it inferred.

## First artifact

`architecture/views/<flow-name>.dot` — one path, labelled edges, unknowns drawn as unknown. Write the DOT with `graphviz`. The reply names the trigger, the outcome, what is confirmed, what is inferred, and the top unknown. Run `architecture_validate` on the model before you cite it; it checks structure and references, not truth.

## Do not

- Do not smooth an unknown step into a happy path. A confirmed partial path plus an explicit "validate next" branch beats a complete unsupported one.
- Do not mix `current`, `target` and `runtime` in one path. One node carries one state, and an edge's state must equal the state of both endpoints. A confirmed runtime observation requires runtime evidence.
- Do not draw an async channel as a synchronous call, or the reverse.
- Do not spend the turn reading documentation. The contract is `schemas/architecture-model.schema.json`, enforced by `architecture_validate`, not by prose.
