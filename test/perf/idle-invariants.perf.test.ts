/**
 * idle-invariants.perf.test.ts — work that must stop or be reused while nothing
 * changes. Operation counts only, never time (see render-invariants).
 *
 * Both guards cover costs that grow with child history or run for as long as
 * the parent session stays open, and neither shows up in a functional test.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentWidget } from "../../src/ui/agent-widget.js";
import { getSessionContextPercent } from "../../src/usage.js";
import { makeFleet, mountWidget } from "../helpers/perf-fixtures.js";

afterEach(() => vi.useRealTimers());

describe("context usage — one stats scan per session change", () => {
  // getSessionStats() scans the whole child session, and the widget asks for
  // the percentage once per running agent per frame.
  function liveSession() {
    let leaf = "a";
    let percent = 42;
    const session = {
      model: {},
      sessionManager: { getLeafId: () => leaf },
      getSessionStats: vi.fn(() => ({ tokens: { input: 0, output: 0, cacheWrite: 0 }, contextUsage: { percent } })),
    };
    return { session, move: (id: string, next: number) => { leaf = id; percent = next; }, set: (next: number) => { percent = next; } };
  }

  it("does not rescan while the leaf and model are unchanged", () => {
    const { session } = liveSession();
    for (let i = 0; i < 50; i++) expect(getSessionContextPercent(session)).toBe(42);
    expect(session.getSessionStats.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("scans again when the leaf or the model changes", () => {
    const { session, move, set } = liveSession();
    expect(getSessionContextPercent(session)).toBe(42);
    move("b", 50);
    expect(getSessionContextPercent(session)).toBe(50);
    set(60);
    session.model = {};
    expect(getSessionContextPercent(session)).toBe(60);
  });
});

describe("AgentWidget — no redraw clock without an active agent", () => {
  // Finished rows stay on screen for a while, but nothing in them changes on
  // its own; an 80 ms clock there redraws the whole TUI for minutes.
  it("stops its timer once the last agent finishes, even with finished rows shown", () => {
    vi.useFakeTimers();
    const records = makeFleet({ running: 1 });
    const w = mountWidget(AgentWidget, records);
    w.widget.ensureTimer();
    expect(vi.getTimerCount()).toBe(1);

    Object.assign(records[0], { status: "completed", completedAt: Date.now() });
    w.update();

    expect(w.render().join("\n")).toContain(records[0].description.slice(0, 20));
    expect(vi.getTimerCount()).toBe(0);
    w.dispose();
  });
});
