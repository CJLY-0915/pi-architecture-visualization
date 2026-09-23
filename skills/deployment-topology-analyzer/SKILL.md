---
name: Deployment Topology Analyzer
description: Load when the question is where the system runs and how it is released: container or service inventory, Compose or Kubernetes topology, environments, release paths, runtime observations. Claims only what manifests and IaC state.
---

# Deployment Topology Analyzer

Answer one question: **where does this run, what talks to what, and how does it get there.** Ship the answer as an inventory in the same turn; routing is private.

## First artifact

`architecture/deployment-inventory.md` — one row per deployable unit: name, kind (compose service, Kubernetes workload, process, VM, external), environment, evidence path with line, status, confidence. Add `architecture/views/deployment-topology.dot` when the topology itself is the question. Nothing else in turn one.

When no model exists yet, the inventory is the artifact. Do not build a full `architecture/model.json` first.

## What the collector can see

`architecture_collect {scopeRoots?, maxFiles?}` is a read-only scan returning a bounded summary: counts and unresolved items. The full model never leaves its process, and nothing is written. Use the summary to confirm a manifest was seen, then read the manifest yourself before asserting anything from it.

| Adapter | Sees | Blind to |
| --- | --- | --- |
| `infra` | Compose top-level `services:` keys and their `depends_on`; Kubernetes `kind` plus the first `metadata.name` | OpenAPI/Swagger, `.github/workflows`, Terraform, every other YAML |
| `manifests` | package.json, requirements.txt, pyproject single-line deps, go.mod, pom.xml, build.gradle coordinates | table TOML deps, `project(':core')`, other package managers |
| `js-ts` | static import/export, string-literal `require()`/`import()`, relative and bare specifiers | dynamic `import()`/`require()`, tsconfig path mapping, re-export barrels |

Collected infra nodes are `container` type with stable ids `container:compose-service:<path>#<service>` and `container:k8s:<kind>/<name>`. Compose services arrive `confirmed`/`high`; Kubernetes workloads arrive `confirmed`/`medium`. A `depends_on` target that is not a collected service yields no edge and is reported as unresolved — an absent edge is not proof of independence. A compose file with no top-level `services:` line yields nothing at all.

## Three states, never merged

| Kind of claim | `state` | Evidence type |
| --- | --- | --- |
| Desired configuration — what manifests declare | `current` | `iac`, `config` |
| Observed runtime — pods, instances, routes, traces, metrics | `runtime` | `runtime` |
| Intended or proposed layout | `target` | user statement, ADR, roadmap |

Runtime topology is not logical system structure. Keep them in separate views and separate node sets; a runtime node never becomes a `component` of the logical model. A `confirmed` node or edge with `state: runtime` must cite evidence of type `runtime`; static evidence alone is rejected by `src/core/validation.js`.

## Workflow

1. Fix the boundary: which environments, which manifests, which deployable units. Everything outside stays out of the inventory.
2. Read the manifests directly. OpenAPI documents, CI workflows and Terraform are invisible to the collector, so those facts come from you reading the file.
3. Per unit, record name, kind, image or entrypoint, ports, dependencies, environment, and the evidence path with line.
4. Split desired configuration from runtime observation from assumption. Anything unobserved becomes a row marked `unknown` together with the check that would settle it.
5. Map the release path only where build, pipeline or deploy evidence exists; otherwise list it as a gap.
6. Run `architecture_validate` on any model you wrote, then `architecture_query` with `mode:"filter"` and `types:["container"]` to confirm the inventory and the model agree.

## Never infer infrastructure from a name

A `k8s/` directory is not a cluster. A Dockerfile is not a deployment. A framework name is not a hosting provider. A compose service is not a production replica. Record what the file states, and record the rest as a gap with the file or command that would close it.

## Evidence

- `high` — a manifest, config, schema, IaC file, runtime capture or authoritative doc states it directly.
- `medium` — several partial signals agree, none states it directly.
- `low` — naming, folder layout, or convention.
- `unknown` — a deliberately recorded gap, with the check that would settle it.

## Do not

- Do not merge runtime observations into the logical structure to make a diagram fuller.
- Do not promote a local dev compose file into production topology.
- Do not cite a directory name, a framework default, or a README adjective as evidence.
- Do not fill missing hosting with a common pattern. Draw the gap.

## Done

The turn ends when `architecture/deployment-inventory.md` exists, every row carries an evidence path, and the reply names what is confirmed, what is assumed, and the top unobserved resources.
