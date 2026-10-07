/**
 * Real extension fixture for the end-to-end test. Registers one tool with
 * `exposure: "codemode"`, which is how pi's built-in MCP extension registers
 * MCP tools: callable from codemode scripts, never declared to the model.
 */
import { Type } from "@sinclair/typebox";

export default function (pi) {
  pi.registerTool({
    name: "e2e_codemode_only",
    label: "E2E Codemode Only",
    description: "Reachable from codemode scripts only. Used only by the end-to-end test.",
    parameters: Type.Object({}),
    exposure: "codemode",
    async execute() {
      return { content: [{ type: "text", text: "ok" }] };
    },
  });
}
