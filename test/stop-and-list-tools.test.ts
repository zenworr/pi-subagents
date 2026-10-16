/**
 * stop-and-list-tools.test.ts — the controls an orchestrating model has over
 * its agents: `stop_subagent`, `get_subagent_result` without an id (the list),
 * and `get_subagent_result`'s `timeout_ms`. Drives the registered tools.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

function makePi() {
  const tools = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools };
}

function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: "/tmp",
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const textOf = (r: any): string => r.content[0].text;

/** A run that keeps going until its signal aborts, then settles with partial output. */
function runUntilAborted() {
  vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, options: any) => new Promise((resolve) => {
    options.signal.addEventListener("abort", () => resolve({
      responseText: "partial findings",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    }), { once: true });
  }) as any);
}

async function spawnBackground(tools: Map<string, any>, name?: string): Promise<string> {
  const res = await tools.get("Agent").execute(
    "tc1",
    { prompt: "go", description: "audit the auth path", subagent_type: "general-purpose", run_in_background: true, name },
    undefined, undefined, ctx(),
  );
  return /Agent ID: (\S+)/.exec(textOf(res))![1];
}

describe("stop_subagent", () => {
  afterEach(() => {
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    vi.restoreAllMocks();
  });

  it("stops a running background agent and returns its partial output, labelled as the caller's stop", async () => {
    runUntilAborted();
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const id = await spawnBackground(tools);

    const out = textOf(await tools.get("stop_subagent").execute("tc2", { agent_id: id }, undefined, undefined, ctx()));

    expect(out).toContain("Status: stopped");
    expect(out).toContain("stopped by you with stop_subagent");
    expect(out).not.toContain("STOPPED BY THE USER");
    expect(out).toContain("partial findings");
  });

  it("accepts the agent's name, like the other tools", async () => {
    runUntilAborted();
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    await spawnBackground(tools, "auth-audit");

    const out = textOf(await tools.get("stop_subagent").execute("tc2", { agent_id: "auth-audit" }, undefined, undefined, ctx()));

    expect(out).toContain("Status: stopped");
  });

  it("refuses an agent that has already finished", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const id = await spawnBackground(tools);
    await tools.get("get_subagent_result").execute("tc3", { agent_id: id, wait: true }, undefined, undefined, ctx());

    const out = textOf(await tools.get("stop_subagent").execute("tc2", { agent_id: id }, undefined, undefined, ctx()));

    expect(out).toContain("is not running (status: completed)");
  });

  it("leaves the result unread when the stop call itself is cancelled", async () => {
    let finish!: (v: any) => void;
    vi.mocked(runAgent).mockReturnValue(new Promise((resolve) => { finish = resolve; }) as any);
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const id = await spawnBackground(tools);
    const caller = new AbortController();

    const call = tools.get("stop_subagent").execute("tc2", { agent_id: id }, caller.signal, undefined, ctx());
    caller.abort();
    await expect(call).rejects.toBeDefined();

    finish({ responseText: "late partial", session: { dispose: vi.fn() }, aborted: false, steered: false });
    const out = textOf(await tools.get("get_subagent_result").execute("tc3", { agent_id: id, wait: true }, undefined, undefined, ctx()));
    expect(out).toContain("late partial");
    expect(out).toContain("stopped by you with stop_subagent");
  });

  it("does not consume the result of an agent that is still stopping", async () => {
    let finish!: (v: any) => void;
    vi.mocked(runAgent).mockReturnValue(new Promise((resolve) => { finish = resolve; }) as any);
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const id = await spawnBackground(tools);
    const caller = new AbortController();
    const call = tools.get("stop_subagent").execute("tc2", { agent_id: id }, caller.signal, undefined, ctx());
    caller.abort();
    await call.catch(() => {});

    const early = textOf(await tools.get("get_subagent_result").execute("tc3", { agent_id: id }, undefined, undefined, ctx()));
    expect(early).toContain("is stopping");

    finish({ responseText: "late partial", session: { dispose: vi.fn() }, aborted: false, steered: false });
    const late = textOf(await tools.get("get_subagent_result").execute("tc4", { agent_id: id, wait: true }, undefined, undefined, ctx()));
    expect(late).toContain("late partial");
  });

  it("refuses to resume an agent whose stopped tool call has not returned", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "partial",
      session: { dispose: vi.fn(), isStreaming: true } as any,
      aborted: false,
      steered: false,
      abandoned: true,
    });
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const id = await spawnBackground(tools);
    await tools.get("get_subagent_result").execute("tc3", { agent_id: id, wait: true }, undefined, undefined, ctx());

    const out = textOf(await tools.get("Agent").execute(
      "tc4", { prompt: "again", description: "d", subagent_type: "general-purpose", resume: id }, undefined, undefined, ctx(),
    ));

    expect(out).toContain("has not returned yet");
  });

  it("reports an unknown agent", async () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    const out = textOf(await tools.get("stop_subagent").execute("tc2", { agent_id: "nope" }, undefined, undefined, ctx()));

    expect(out).toContain('Agent not found: "nope"');
  });
});

describe("get_subagent_result", () => {
  afterEach(() => {
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    vi.restoreAllMocks();
  });

  it("lists every agent when agent_id is omitted", async () => {
    runUntilAborted();
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const id = await spawnBackground(tools, "auth-audit");

    const out = textOf(await tools.get("get_subagent_result").execute("tc2", {}, undefined, undefined, ctx()));

    expect(out).toContain(id);
    expect(out).toContain("auth-audit");
    expect(out).toContain("running");
    expect(out).toContain("audit the auth path");
  });

  it("says so when there are no agents", async () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    const out = textOf(await tools.get("get_subagent_result").execute("tc2", {}, undefined, undefined, ctx()));

    expect(out).toBe("No agents in this session.");
  });

  it("stops waiting at timeout_ms and leaves the agent running", async () => {
    runUntilAborted();
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const id = await spawnBackground(tools);

    const out = textOf(await tools.get("get_subagent_result").execute(
      "tc2", { agent_id: id, wait: true, timeout_ms: 20 }, undefined, undefined, ctx(),
    ));

    expect(out).toContain("Status: running");
    expect(out).toContain("the wait timed out");
    const list = textOf(await tools.get("get_subagent_result").execute("tc3", {}, undefined, undefined, ctx()));
    expect(list).toContain("running");
  });

  it("names the time limit for a run that max_minutes aborted", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "half done",
      session: { dispose: vi.fn() } as any,
      aborted: true,
      steered: true,
      limit: "time",
    });
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const id = await spawnBackground(tools);

    const out = textOf(await tools.get("get_subagent_result").execute("tc2", { agent_id: id, wait: true }, undefined, undefined, ctx()));

    expect(out).toContain("hit the time limit");
    expect(out).toContain("half done");
  });
});

describe("Agent max_minutes", () => {
  afterEach(() => {
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    vi.restoreAllMocks();
  });

  it("is refused together with schedule", async () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    const out = textOf(await tools.get("Agent").execute(
      "tc1",
      { prompt: "go", description: "d", subagent_type: "general-purpose", schedule: "+10m", max_minutes: 3 },
      undefined, undefined, ctx(),
    ));

    expect(out).toContain("Cannot combine `schedule` with `max_minutes`");
  });

  it("hands the time limit to the run", async () => {
    runUntilAborted();
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    await tools.get("Agent").execute(
      "tc1",
      { prompt: "go", description: "d", subagent_type: "general-purpose", run_in_background: true, max_minutes: 3 },
      undefined, undefined, ctx(),
    );

    expect(vi.mocked(runAgent).mock.lastCall?.[3]).toMatchObject({ maxMinutes: 3 });
  });
});
