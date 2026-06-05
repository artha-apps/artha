/**
 * Bodhi — Composable Sub-Capabilities.
 *
 * Exposes the platform's own capabilities (Skills + Agents) to the model AS A
 * TOOL. With `invoke_capability`, a high-level run can delegate a self-contained
 * piece of work to a trusted, pre-scoped capability — research-brief,
 * crm-enrich, file-organizer — instead of re-deriving it from raw tools.
 *
 * The differentiating guarantee is PERMISSION MONOTONICITY: a child capability
 * runs with the INTERSECTION of the parent's tool scope and its own, so a child
 * can never do anything the parent itself wasn't allowed to do. Composition
 * without privilege escalation — a property single-loop agents can't offer.
 *
 * Recursion is depth-bounded (see MAX_CAPABILITY_DEPTH) so capabilities can't
 * fan out forever. Each sub-call is an ordinary tool call in the trace, so
 * policies (policy.ts) and receipts (receipts.ts) apply to it recursively.
 */
import OpenAI from 'openai';
import { SkillRegistry } from '../skills/registry';

/** Max nesting: a top-level run (depth 0) may call a capability (depth 1) which
 *  may call one more (depth 2). Beyond this the tool is withheld. */
export const MAX_CAPABILITY_DEPTH = 2;

/** True when this is the capability-delegation tool. */
export function isSubcapabilityTool(name: string): boolean {
  return name === 'invoke_capability';
}

/** Build the `invoke_capability` schema, with the live catalogue of enabled
 *  capabilities baked into the description so the model knows what it can call.
 *  Returns [] when there is nothing to delegate to (so the tool never appears
 *  with an empty menu). */
export function getSubcapabilityToolSchemas(): OpenAI.ChatCompletionTool[] {
  let catalogue: { slug: string; name: string; description: string; kind: string }[] = [];
  try {
    catalogue = SkillRegistry.getInstance().listEnabled().map(s => ({
      slug: s.slug, name: s.name, description: s.description, kind: s.kind,
    }));
  } catch { /* DB not ready — no catalogue */ }
  if (!catalogue.length) return [];

  const menu = catalogue
    .map(c => `- ${c.slug} (${c.kind}): ${c.description || c.name}`)
    .join('\n');

  return [{
    type: 'function',
    function: {
      name: 'invoke_capability',
      description:
        `Delegate a self-contained sub-task to one of Artha's trusted capabilities and get its result back. ` +
        `Use this when a step matches a capability's specialty (e.g. researching a topic, enriching CRM data, ` +
        `organising files) instead of doing it tool-by-tool yourself. The capability runs with a tool scope ` +
        `that can never exceed your own. Available capabilities:\n${menu}`,
      parameters: {
        type: 'object',
        properties: {
          capability_id: {
            type: 'string',
            description: 'The slug of the capability to invoke (from the list above).',
          },
          input: {
            type: 'string',
            description: 'A clear, self-contained instruction for the capability — it does not see your conversation.',
          },
        },
        required: ['capability_id', 'input'],
      },
    },
  }];
}

/** Compute the tool scope a child capability runs with: the INTERSECTION of the
 *  parent's effective allowlist and the child's own. Empty list = "all tools",
 *  which is why the rules below treat an empty side as "no constraint":
 *
 *    parent ∅ (all)  ∩ child X        = child X
 *    parent X        ∩ child ∅ (all)  = parent X   ← child is clamped to parent
 *    parent X        ∩ child Y        = entries of Y permitted under X
 *
 * Pattern entries (prefix "_") are preserved when they are a subset of, or
 * equal to, something the parent permits. The result can never widen the
 * parent's scope. */
export function intersectToolScopes(parent: string[], child: string[]): string[] {
  const P = parent ?? [];
  const C = child ?? [];
  if (!P.length) return [...C];            // parent unrestricted → child stands
  if (!C.length) return [...P];            // child unrestricted → clamp to parent

  const permittedByParent = (entry: string): boolean =>
    P.some(p => {
      if (p === '*') return true;
      if (p.endsWith('_')) {
        // parent prefix covers child entry if child is the same prefix, a longer
        // prefix, or an exact name starting with it.
        return entry === p || entry.startsWith(p);
      }
      return entry === p; // parent exact name → child must be that exact name
    });

  const result = C.filter(permittedByParent);
  // If nothing survived, the child shares no tools with the parent: return a
  // sentinel that grants nothing (a non-matching exact name) so the sub-run is
  // effectively read-only-nothing rather than silently "all tools".
  return result.length ? result : ['__no_tools__'];
}
