// Standing routing rule for the architecture-visualization plugin.
//
// Runs inside the agent process as a pi ExtensionAPI module (jiti-loaded,
// `contributes.agentExtensions`). It exists because `contributes.skills` only
// puts a catalog in the base prompt: a scenario skill is loaded when the model
// happens to match its description. For a router skill that is not reliable
// enough, so this module appends one explicit trigger to every turn's system
// prompt.
//
// Deliberately dependency-free: no imports, no fs, no network, no clock, no
// randomness. The rule is a fixed string, so the same event always yields the
// same prompt and the module is testable without an agent process.

const RULE_MARKER = '## Architecture Visualization';

const RULE = `${RULE_MARKER}

If the user asks what this system is, where its boundaries lie, what depends on
what, what a change would affect, where it runs, how it should evolve, whether
it is risky, or whether the architecture docs are still current, load the
\`Architecture Explore\` skill before answering and follow it. It selects one
scenario skill and expects a first artifact on disk in the same turn. Never
answer such a question from a directory listing or package manifests alone.`;

/**
 * Appends the standing rule to the prompt the agent is about to receive.
 *
 * The host replaces the system prompt with whatever `systemPrompt` a handler
 * returns, so the base text must be carried through rather than replaced.
 * Appending is idempotent: a second call on an already-ruled prompt returns it
 * unchanged, so re-runs and merged handlers cannot stack the rule.
 *
 * @param {{systemPrompt?: unknown}} event Host event; only `systemPrompt` is read.
 * @returns {{systemPrompt: string}} The prompt the agent should use.
 */
export function applyStandingRule(event) {
  const base = typeof event?.systemPrompt === 'string' ? event.systemPrompt : '';
  if (base.includes(RULE_MARKER)) return { systemPrompt: base };
  return { systemPrompt: base === '' ? RULE : `${base}\n\n${RULE}` };
}

/** @returns {string} The exact text appended to the system prompt. */
export function buildStandingRule() {
  return RULE;
}

/**
 * Plugin entry point declared by `contributes.agentExtensions`.
 *
 * @param {{on?: Function}} pi Host extension API. A missing or foreign `pi` is
 *   a no-op rather than a throw, so an unexpected host shape cannot break the
 *   agent turn this module is loaded into.
 */
export default function workflowRule(pi) {
  if (!pi || typeof pi.on !== 'function') return;
  pi.on('before_agent_start', (event) => applyStandingRule(event));
}
