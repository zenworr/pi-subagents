/**
 * context.test.ts — Parent conversation context extraction for inherit_context spawns.
 *
 * buildParentContext shapes what a subagent sees from its parent; silent bugs
 * here would feed wrong context into spawns. Tests use realistic SessionEntry
 * shapes and a minimal ExtensionContext stub — no mocking beyond the one
 * getBranch() call the function actually reads. Compaction tests also use Pi's
 * in-memory session manager, without model calls or persisted sessions.
 */

import { type ExtensionContext, type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { buildParentContext, extractText } from "../src/context.js";

function makeCtx(entries: unknown[]): ExtensionContext {
  const branch = entries.map((entry, index) => ({
    ...(entry as object),
    id: `entry-${index}`,
    parentId: index === 0 ? null : `entry-${index - 1}`,
    timestamp: "2026-01-01T00:00:00.000Z",
  })) as SessionEntry[];
  return { sessionManager: { getBranch: () => branch } } as unknown as ExtensionContext;
}

function userMsg(content: string | unknown[]) {
  return { type: "message", message: { role: "user", content } };
}

function assistantMsg(blocks: unknown[]) {
  return { type: "message", message: { role: "assistant", content: blocks } };
}

describe("extractText", () => {
  it("joins multiple text blocks with newlines", () => {
    expect(extractText([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
  });

  it("filters out non-text blocks (tool_use, etc.)", () => {
    expect(
      extractText([
        { type: "text", text: "keep" },
        { type: "tool_use", name: "x", input: {} },
        { type: "text", text: "also keep" },
      ]),
    ).toBe("keep\nalso keep");
  });

  it("treats a text block with missing text field as empty", () => {
    expect(extractText([{ type: "text" }, { type: "text", text: "x" }])).toBe("\nx");
  });

  it("returns empty string for an empty content array", () => {
    expect(extractText([])).toBe("");
  });
});

describe("buildParentContext", () => {
  it("returns empty string for an empty branch", () => {
    expect(buildParentContext(makeCtx([]))).toBe("");
  });

  it("returns empty string when no entries produce extractable content", () => {
    // toolResult is skipped, empty-summary compaction is skipped
    const out = buildParentContext(
      makeCtx([
        { type: "message", message: { role: "tool_result", content: "..." } },
        { type: "compaction", summary: "" },
      ]),
    );
    expect(out).toBe("");
  });

  it("wraps a user+assistant exchange with the parent-context header and task footer", () => {
    const out = buildParentContext(
      makeCtx([userMsg("hello"), assistantMsg([{ type: "text", text: "hi back" }])]),
    );
    expect(out).toContain("# Parent Conversation Context");
    expect(out).toContain("[User]: hello");
    expect(out).toContain("[Assistant]: hi back");
    expect(out).toMatch(/# Your Task \(below\)\n$/);
    // Entries are joined with a blank line, preserving conversation order
    expect(out).toContain("[User]: hello\n\n[Assistant]: hi back");
  });

  it("accepts user messages whose content is content-blocks (not just a string)", () => {
    const out = buildParentContext(makeCtx([userMsg([{ type: "text", text: "from blocks" }])]));
    expect(out).toContain("[User]: from blocks");
  });

  it("replaces summarized history and puts the summary before the retained messages", () => {
    const out = buildParentContext(
      makeCtx([
        userMsg("orig question"),
        userMsg("retained question"),
        { type: "compaction", summary: "we discussed X", firstKeptEntryId: "entry-1" },
        assistantMsg([{ type: "text", text: "follow-up" }]),
      ]),
    );
    expect(out).not.toContain("orig question");
    expect(out).toContain("[Summary]: we discussed X\n\n[User]: retained question\n\n[Assistant]: follow-up");
  });

  it("inherits only the latest custom summary after repeated compactions", () => {
    const sessionManager = SessionManager.inMemory();
    for (let index = 0; index < 28; index++) {
      sessionManager.appendMessage({ role: "user", content: `obsolete-${index}`, timestamp: index });
      const retained = sessionManager.appendMessage({ role: "user", content: `kept-${index}`, timestamp: index });
      sessionManager.appendCompaction(
        `summary-${index}\n## Reflections\nreflection-${index}\n## Observations\nobservation-${index}`,
        retained,
        1000,
        { source: "custom-compactor" },
        true,
      );
    }
    sessionManager.appendMessage({ role: "user", content: "latest request", timestamp: 28 });
    const before = JSON.stringify(sessionManager.getEntries());
    const out = buildParentContext({ sessionManager } as ExtensionContext);
    expect(out.match(/\[Summary\]:/g)).toHaveLength(1);
    expect(out).toContain("summary-27\n## Reflections\nreflection-27\n## Observations\nobservation-27");
    expect(out).toContain("[User]: kept-27\n\n[User]: latest request");
    expect(out).not.toContain("obsolete-");
    for (let index = 0; index < 27; index++) {
      expect(out).not.toContain(`summary-${index}\n`);
      expect(out).not.toContain(`kept-${index}\n`);
    }
    expect(JSON.stringify(sessionManager.getEntries())).toBe(before);
  });

  it("supports compact-all summaries with no retained pre-compaction messages", () => {
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage({ role: "user", content: "discarded history", timestamp: 0 });
    sessionManager.appendCompaction("complete summary", "", 1000);
    sessionManager.appendMessage({ role: "user", content: "new request", timestamp: 1 });
    const out = buildParentContext({ sessionManager } as ExtensionContext);
    expect(out).not.toContain("discarded history");
    expect(out).toContain("[Summary]: complete summary\n\n[User]: new request");
  });

  it("inherits the selected branch and its summary without abandoned messages", () => {
    const sessionManager = SessionManager.inMemory();
    const root = sessionManager.appendMessage({ role: "user", content: "root request", timestamp: 0 });
    sessionManager.appendMessage({ role: "user", content: "abandoned message", timestamp: 1 });
    sessionManager.branchWithSummary(root, "branch decisions");
    sessionManager.appendMessage({ role: "user", content: "selected request", timestamp: 2 });
    const out = buildParentContext({ sessionManager } as ExtensionContext);
    expect(out).not.toContain("abandoned message");
    expect(out).toContain("[User]: root request\n\n[Summary]: branch decisions\n\n[User]: selected request");
    sessionManager.resetLeaf();
    expect(buildParentContext({ sessionManager } as ExtensionContext)).toBe("");
  });

  it("skips tool_result messages — they're too verbose for inherited context", () => {
    const out = buildParentContext(
      makeCtx([
        userMsg("real user"),
        { type: "message", message: { role: "tool_result", content: "noisy tool output" } },
        assistantMsg([{ type: "text", text: "real assistant" }]),
      ]),
    );
    expect(out).not.toContain("noisy tool output");
    expect(out).toContain("[User]: real user");
    expect(out).toContain("[Assistant]: real assistant");
  });

  it("trims and skips whitespace-only messages", () => {
    const out = buildParentContext(
      makeCtx([userMsg("   \n  "), assistantMsg([{ type: "text", text: "non-empty" }])]),
    );
    expect(out).not.toMatch(/\[User\]:/);
    expect(out).toContain("[Assistant]: non-empty");
  });

  it("ignores assistant messages whose only content is non-text blocks", () => {
    // Assistant emitted only a tool_use — nothing extractable, so it shouldn't appear
    const out = buildParentContext(
      makeCtx([
        userMsg("question"),
        assistantMsg([{ type: "tool_use", name: "x", input: {} }]),
      ]),
    );
    expect(out).toContain("[User]: question");
    expect(out).not.toContain("[Assistant]:");
  });
});
