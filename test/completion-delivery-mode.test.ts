import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

describe("completionDeliveryMode", () => {
  let hermetic: Hermetic | undefined;

  afterEach(() => {
    vi.mocked(runAgent).mockReset();
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    registerAgents(new Map());
    hermetic?.restore();
    hermetic = undefined;
  });

  async function completedNotifications(settings: Record<string, unknown>, count: number) {
    hermetic = hermeticDir({ settings: { schedulingEnabled: false, ...settings } });
    const { pi, tools } = makePi();
    vi.mocked(runAgent).mockImplementation(async () => {
      if (settings.defaultJoinMode === "group") await new Promise((resolve) => setTimeout(resolve, 180));
      return { responseText: "done", session: { dispose: vi.fn() } as any, aborted: false, steered: false };
    });
    subagentsExtension(pi);
    const calls = Array.from({ length: count }, (_, i) => tools.get("Agent").execute(
      `tc-${i}`, { prompt: "go", description: `task ${i}`, subagent_type: "general-purpose", run_in_background: true },
      undefined, undefined, ctx(),
    ));
    await Promise.all(calls);
    await flush();
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalled(), { timeout: 5000 });
    return pi.sendMessage.mock.calls.filter(([message]: any[]) => message.customType === "subagent-notification");
  }

  it("steers individual completions by default", async () => {
    const sent = await completedNotifications({ defaultJoinMode: "async" }, 1);
    expect(sent).toHaveLength(1);
    expect(sent[0][1]).toEqual({ deliverAs: "steer", triggerTurn: true });
  });

  it("retains the old follow-up behavior when selected", async () => {
    const sent = await completedNotifications({ defaultJoinMode: "async", completionDeliveryMode: "followUp" }, 1);
    expect(sent).toHaveLength(1);
    expect(sent[0][1]).toEqual({ deliverAs: "followUp", triggerTurn: true });
  });

  it("steers grouped completions by default", async () => {
    const sent = await completedNotifications({ defaultJoinMode: "group" }, 2);
    expect(sent).toHaveLength(1);
    expect(sent[0][0].content).toContain("Background agent group completed");
    expect(sent[0][1]).toEqual({ deliverAs: "steer", triggerTurn: true });
  });

  it("delivers grouped completions as follow-ups when selected", async () => {
    const sent = await completedNotifications({ defaultJoinMode: "group", completionDeliveryMode: "followUp" }, 2);
    expect(sent).toHaveLength(1);
    expect(sent[0][1]).toEqual({ deliverAs: "followUp", triggerTurn: true });
  });

  it("uses the selected mode for workflow completion too", async () => {
    hermetic = hermeticDir({ settings: {
      schedulingEnabled: false, workflowsEnabled: true, completionDeliveryMode: "followUp",
    } });
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    await tools.get("SubagentWorkflow").execute(
      "wf-1", { script: 'export const meta = { name: "delivery-test", description: "test" };\nreturn "done";' },
      undefined, undefined, ctx({ cwd: hermetic.dir }),
    );
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalled(), { timeout: 5000 });
    expect(pi.sendMessage.mock.calls.at(-1)?.[1]).toEqual({ deliverAs: "followUp", triggerTurn: true });
  });
});
