import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
};

it.each([
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "@sinclair/typebox",
  "typebox",
])("uses the host-provided %s package", (name) => {
  expect(manifest.dependencies).not.toHaveProperty(name);
  expect(manifest.peerDependencies[name]).toBe("*");
});
