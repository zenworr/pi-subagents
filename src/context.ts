/**
 * context.ts — Extract parent conversation context for subagent inheritance.
 */

import { buildSessionContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Extract text from a message content block array. */
export function extractText(content: unknown[]): string {
  return content
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text ?? "")
    .join("\n");
}

/**
 * Build a text representation of the parent conversation context.
 * Used when inherit_context is true to give the subagent visibility
 * into what has been discussed/done so far.
 */
export function buildParentContext(ctx: ExtensionContext): string {
  // Pi applies the latest compaction boundary, including custom compactor summaries.
  const { messages } = buildSessionContext(ctx.sessionManager.getBranch());
  const parts: string[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      const text = typeof msg.content === "string"
        ? msg.content
        : extractText(msg.content);
      if (text.trim()) parts.push(`[User]: ${text.trim()}`);
    } else if (msg.role === "assistant") {
      const text = extractText(msg.content);
      if (text.trim()) parts.push(`[Assistant]: ${text.trim()}`);
    } else if (msg.role === "compactionSummary" || msg.role === "branchSummary") {
      if (msg.summary) parts.push(`[Summary]: ${msg.summary}`);
    }
    // Skip toolResult messages — too verbose for context
  }

  if (parts.length === 0) return "";

  return `# Parent Conversation Context
The following is the conversation history from the parent session that spawned you.
Use this context to understand what has been discussed and decided so far.

${parts.join("\n\n")}

---
# Your Task (below)
`;
}
