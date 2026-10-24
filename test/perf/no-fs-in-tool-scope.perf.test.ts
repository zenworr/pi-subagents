/**
 * no-fs-in-tool-scope.perf.test.ts — a child's tool-scope check must not read
 * package manifests unless an `ext:` selector needs extension aliases.
 *
 * The check runs on every child tool call and every turn end. Resolving aliases
 * reads each extension's nearest package.json, so with a dozen extensions every
 * call paid dozens of synchronous reads for a result nothing used.
 *
 * Own file: the `node:fs` mock applies to the whole module graph.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const READS: string[] = [];

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const wrapped: Record<string, unknown> = {
    ...actual,
    readFileSync: (...args: unknown[]) => {
      READS.push(String(args[0]));
      return (actual.readFileSync as any)(...args);
    },
  };
  return { ...wrapped, default: wrapped };
});

const { installExtensionToolScope } = await import("../../src/agent-runner.js");

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** An installed pi package exposing `tool` through `./src/index.ts`. */
function extension(pkg: string, tool: string) {
  const dir = mkdtempSync(join(tmpdir(), "subagents-scope-"));
  dirs.push(dir);
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: pkg, pi: { extensions: ["./src/index.ts"] } }));
  writeFileSync(join(dir, "src", "index.ts"), "export default () => {};");
  return { path: join(dir, "src", "index.ts"), tools: new Map([[tool, {}]]) };
}

function install(extNames: string[], narrowing = new Map<string, Set<string>>()) {
  const extensions = [extension("@scope/alpha", "alpha_tool"), extension("@scope/beta", "beta_tool")];
  let active = ["read"];
  const session: any = {
    agent: {},
    getActiveToolNames: () => active,
    getAllTools: () => extensions.flatMap((e) => [...e.tools.keys()]).map((name) => ({ name })),
    getToolDefinition: () => ({}),
    setActiveToolsByName: (names: string[]) => {
      active = names;
    },
    subscribe: () => () => {},
  };
  const gate: { allows?: (name: string) => boolean } = {};
  installExtensionToolScope(session, {
    loader: { getExtensions: () => ({ extensions }) } as any,
    toolNames: ["read"],
    disallowedSet: undefined,
    extNames: new Set(extNames),
    narrowing,
    readmitToolNames: new Set(),
    nestedCallGate: gate,
  });
  return gate;
}

describe("tool-scope check", () => {
  it("reads no manifest when no `ext:` selector is set", () => {
    const gate = install([]);
    READS.length = 0;

    expect(gate.allows?.("alpha_tool")).toBe(true);
    expect(gate.allows?.("beta_tool")).toBe(true);
    expect(READS).toEqual([]);
  });

  it("still resolves package aliases for selectors", () => {
    expect(install(["alpha"]).allows?.("beta_tool")).toBe(false);
    expect(install(["alpha"]).allows?.("alpha_tool")).toBe(true);
    const narrowed = install([], new Map([["beta", new Set(["other"])]]));
    expect(narrowed.allows?.("beta_tool")).toBe(false);
    expect(narrowed.allows?.("alpha_tool")).toBe(true);
  });
});
