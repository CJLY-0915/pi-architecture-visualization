'use strict';

const { CODES } = require('../core/error-codes');
const { containerNodeId, edgeId } = require('./ids');

// infra adapter: container-level infrastructure declarations.
//
// Line-oriented heuristics, NOT a YAML or TOML parser: lines are matched with
// regular expressions after the trailing comment is cut off, so nesting is
// approximated by indentation width instead of being parsed.
//
// Supported range:
//   - docker-compose.yml/.yaml, compose.yml/.yaml: the top-level `services:`
//     block; every key indented exactly two spaces becomes a `container` node
//     (`container:compose-service:<path>#<service>`), and its `depends_on`
//     entries become `depends_on` edges between collected services
//   - Kubernetes manifests (*.yml/*.yaml containing a `kind:` line): the first
//     `kind` value plus the `name` of the first `metadata:` block become one
//     `container` node (`container:k8s:<kind>/<name>`, confidence medium)
//
// Everything else this adapter matches is indexed only: exactly one
// `unsupported_input` entry and no node or edge. That covers OpenAPI/Swagger
// documents (basename starting with `openapi.` or `swagger.`), GitHub Actions
// workflows (`.github/workflows/*.yml|*.yaml`), Terraform files (*.tf) and any
// other .yml/.yaml file.
//
// Limitations, reported instead of guessed:
//   - a compose file without a top-level `services:` line reports
//     unsupported_input and produces nothing
//   - a `depends_on` target that is not one of the collected services reports
//     unresolved_reference and produces no edge
//   - a Kubernetes manifest whose first `metadata:` block has no `name:` at
//     indent >= 2 reports unsupported_input and produces no node
//
// Known heuristic limits (silent, no diagnostic):
//   - every line is cut at the first `#`, so a `#` inside a quoted scalar
//     truncates that line; YAML anchors, aliases, `extends`, profiles,
//     `include:`, multi-document streams and mapping-form
//     `depends_on: {db: {...}}` are not modelled
//   - only the first `kind` / `metadata` pair of a file is used
//   - `.github/workflows/*.yml` that happens to contain a top-level `kind:`
//     line is classified as a Kubernetes manifest, because the Kubernetes
//     check runs before the CI check; the CI branch is therefore only reached
//     for workflows without any `kind:` line
//   - compose service detection needs indentation of exactly two spaces, so a
//     file indented differently is read as "no services"
//   - the output depends only on the file text: no randomness, no clock, no
//     iteration over object keys

const COMPOSE_FILE_NAMES = Object.freeze(['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']);
const YAML_EXTENSIONS = Object.freeze(['.yml', '.yaml']);
const OPENAPI_PREFIXES = Object.freeze(['openapi.', 'swagger.']);
const CI_WORKFLOW_PATTERN = /^\.github\/workflows\/.+\.ya?ml$/;
const TERRAFORM_EXTENSION = '.tf';
const SERVICES_LINE = 'services:';
const KIND_PATTERN = /^kind:\s*(\S+)/;
const METADATA_LINE_PATTERN = /^metadata:\s*$/;
const METADATA_NAME_PATTERN = /^ {2,}name:\s*(\S+)\s*$/;
const SERVICE_KEY_PATTERN = /^ {2}([^\s:#][^:]*?):\s*$/;
const DEPENDS_ON_PATTERN = /^ {4,}depends_on:\s*(.*)$/;
const DEPENDS_ON_ITEM_PATTERN = /^ {4,}-\s+(.+?)\s*$/;
const INLINE_ARRAY_PATTERN = /^\[(.*)\]$/;
const TOP_LEVEL_PATTERN = /^\S/;
const QUOTED_VALUE_PATTERN = /^(['"])(.*)\1$/;

function basenameOf(path) {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}

function isYamlName(name) {
  return YAML_EXTENSIONS.some((extension) => name.endsWith(extension));
}

// Cuts the line at the first "#" and drops trailing blanks; leading indentation
// is preserved because the compose and Kubernetes heuristics depend on it.
function stripComment(line) {
  const index = line.indexOf('#');
  const code = index === -1 ? line : line.slice(0, index);
  return code.replace(/[ \t]+$/, '');
}

function normalizeEntry(value) {
  const trimmed = value.trim();
  const quoted = trimmed.match(QUOTED_VALUE_PATTERN);
  return (quoted === null ? trimmed : quoted[2]).trim();
}

function reportUnsupported(context, path, reason) {
  context.unresolved(CODES.UNSUPPORTED_INPUT, path, `${reason} Nothing was inferred from this file; it is indexed only.`);
}

// Single pass over the services block. Returns the services in file order plus
// the dependencies seen for each of them; `foundServices` is false when the
// file has no top-level `services:` line at all.
function parseCompose(text) {
  const services = [];
  const dependencies = new Map();
  let foundServices = false;
  let current = null;
  let inDependsOnList = false;

  const addDependency = (target) => {
    const list = dependencies.get(current);
    if (!list.includes(target)) list.push(target);
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw);
    if (line.trim() === '') continue;

    if (!foundServices) {
      if (line === SERVICES_LINE) foundServices = true;
      continue;
    }
    if (TOP_LEVEL_PATTERN.test(line)) break;

    const service = line.match(SERVICE_KEY_PATTERN);
    if (service !== null) {
      current = service[1].trim();
      inDependsOnList = false;
      if (!dependencies.has(current)) {
        dependencies.set(current, []);
        services.push(current);
      }
      continue;
    }

    if (current === null) continue;

    const dependsOn = line.match(DEPENDS_ON_PATTERN);
    if (dependsOn !== null) {
      const rest = dependsOn[1].trim();
      inDependsOnList = rest === '';
      const inline = rest === '' ? null : rest.match(INLINE_ARRAY_PATTERN);
      if (inline !== null) {
        for (const entry of inline[1].split(',')) {
          const target = normalizeEntry(entry);
          if (target !== '') addDependency(target);
        }
      }
      continue;
    }

    if (inDependsOnList) {
      const item = line.match(DEPENDS_ON_ITEM_PATTERN);
      if (item === null) inDependsOnList = false;
      else {
        const target = normalizeEntry(item[1]);
        if (target !== '') addDependency(target);
      }
    }
  }

  return { foundServices, services, dependencies };
}

function analyzeCompose(file, context) {
  const parsed = parseCompose(file.text);
  if (!parsed.foundServices) {
    reportUnsupported(context, file.path, 'No top-level "services:" line was found.');
    return;
  }

  const evidenceId = context.addEvidence({ path: file.path, type: 'iac' });
  const nodeIds = new Map();
  for (const name of parsed.services) {
    const id = containerNodeId('compose-service', `${file.path}#${name}`);
    nodeIds.set(name, id);
    context.addNode({
      id,
      name,
      type: 'container',
      status: 'confirmed',
      confidence: 'high',
      evidenceIds: [evidenceId],
    });
  }

  const emitted = new Set();
  for (const name of parsed.services) {
    const sourceId = nodeIds.get(name);
    for (const target of parsed.dependencies.get(name)) {
      const targetId = nodeIds.get(target);
      if (targetId === undefined) {
        context.unresolved(CODES.UNRESOLVED_REFERENCE, file.path,
          `Service "${name}" declares a dependency on "${target}", which is not a service declared in this file; no edge was derived.`);
        continue;
      }
      const id = edgeId(sourceId, targetId, 'depends_on');
      if (emitted.has(id)) continue;
      emitted.add(id);
      context.addEdge({
        id,
        source: sourceId,
        target: targetId,
        type: 'depends_on',
        status: 'confirmed',
        confidence: 'high',
        evidenceIds: [evidenceId],
      });
    }
  }
}

function firstKind(text) {
  for (const raw of text.split(/\r?\n/)) {
    const match = stripComment(raw).trim().match(KIND_PATTERN);
    if (match !== null) return match[1];
  }
  return null;
}

// First `name:` at indent >= 2 inside the first `metadata:` block; null when the
// block has no such line or is never opened.
function firstNameInMetadata(text) {
  let inMetadata = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw);
    if (line.trim() === '') continue;
    if (inMetadata) {
      if (TOP_LEVEL_PATTERN.test(line)) return null;
      const name = line.match(METADATA_NAME_PATTERN);
      if (name !== null) return name[1];
      continue;
    }
    if (METADATA_LINE_PATTERN.test(line.trim())) inMetadata = true;
  }
  return null;
}

function analyzeKubernetes(file, context, kind) {
  const name = firstNameInMetadata(file.text);
  if (name === null) {
    reportUnsupported(context, file.path, `A "kind: ${kind}" line was found but no metadata name was derived.`);
    return;
  }
  const key = `${kind}/${name}`;
  context.addNode({
    id: containerNodeId('k8s', key),
    name: key,
    type: 'container',
    status: 'confirmed',
    confidence: 'medium',
    evidenceIds: [context.addEvidence({ path: file.path, type: 'iac' })],
  });
}

module.exports = {
  create() {
    return {
      id: 'infra',
      match(path) {
        const base = basenameOf(path);
        return COMPOSE_FILE_NAMES.includes(base)
          || isYamlName(base)
          || OPENAPI_PREFIXES.some((prefix) => base.startsWith(prefix))
          || base.endsWith(TERRAFORM_EXTENSION);
      },
      analyze(file, context) {
        const base = basenameOf(file.path);

        if (COMPOSE_FILE_NAMES.includes(base)) {
          analyzeCompose(file, context);
          return;
        }

        if (isYamlName(base)) {
          const kind = firstKind(file.text);
          if (kind !== null) {
            analyzeKubernetes(file, context, kind);
            return;
          }
        }

        if (OPENAPI_PREFIXES.some((prefix) => base.startsWith(prefix))) {
          reportUnsupported(context, file.path, 'OpenAPI/Swagger documents are not modelled by this collector.');
          return;
        }

        if (CI_WORKFLOW_PATTERN.test(file.path)) {
          reportUnsupported(context, file.path, 'CI workflow configuration is not modelled by this collector.');
          return;
        }

        if (base.endsWith(TERRAFORM_EXTENSION)) {
          reportUnsupported(context, file.path, 'Terraform configuration is not modelled by this collector.');
          return;
        }

        reportUnsupported(context, file.path, 'This configuration type is not modelled by this collector.');
      },
    };
  },
  COMPOSE_FILE_NAMES,
  OPENAPI_PREFIXES,
  CI_WORKFLOW_PATTERN,
};
