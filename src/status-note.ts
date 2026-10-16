/**
 * status-note.ts — Honest framing for an agent result: the parenthetical status
 * note for a non-normal outcome, and the salvaged partial output of a failure.
 *
 * Lives here rather than in an index.ts closure because both entry points need
 * it — the top-level tools and the nested delegation tools, which can't import
 * from index.ts (that is the extension entry, and it already reaches these tools
 * through agent-runner).
 */

import type { AgentRecord } from "./types.js";

/** What the status notes read off a record. */
type NoteRecord = Pick<AgentRecord, "status" | "limit" | "stoppedByCaller">;

/**
 * Explicit parenthetical note for a non-normal terminal outcome, so the parent
 * agent can't mistake partial output for a completed result. Empty string for a
 * clean completion (and any unknown/non-terminal status).
 *
 * `stopped` (a human aborted it) is deliberately distinct from `aborted` (the
 * turn or time limit was hit) — the parent should treat human intervention
 * differently from a budget cutoff. A stop the parent made itself with
 * `stop_subagent` is not a human intervention, so it says so.
 */
export function getStatusNote(record: NoteRecord): string {
  switch (record.status) {
    case "stopped":
      return record.stoppedByCaller
        ? " (stopped by you with stop_subagent before completion — output is partial; the task was NOT finished)"
        : " (STOPPED BY THE USER before completion — output is partial; the task was NOT finished)";
    case "aborted":
      return ` (aborted — hit the ${limitName(record)} before completion; output may be incomplete)`;
    case "steered":
      return ` (wrapped up at the ${limitName(record)} — output may be partial)`;
    default:
      return "";
  }
}

/**
 * Foreground variant of `getStatusNote`. A foreground caller is in a different
 * position from a background one, so it needs different text:
 *
 *   - It already holds the agent's ENTIRE output inline, whereas the background
 *     notification carries a 500-char preview. So only here can we truthfully
 *     say there is nothing more to fetch — which is the whole point, because
 *   - it has no agent id. The id travels in the tool result's renderer
 *     `details`, which is never serialized to the model. A parent that reads
 *     "output may be partial" as "truncated, go retrieve the rest" therefore
 *     has nothing valid to call `get_subagent_result` with, and will invent an
 *     id (#174).
 *
 * Only the lead clause varies between the three, and each variation carries
 * information: `wrapped up` vs `aborted` tells the parent whether the output is
 * a considered final answer or a fragment, and `stopped` shouts because a human
 * intervening outranks everything else in the string. Only `steered` hedges on
 * completion — it was told to wrap up and did, so it may well have finished at
 * the limit; an aborted run blew through its grace turns while still working,
 * and `stopped` can only fire on a running agent, so neither ever delivered a
 * final answer. Identical confidence gets identical wording: phrasing one fact
 * two ways invites a hunt for a distinction that isn't there.
 *
 * Every clause is a statement about state, never an instruction to act, and
 * `get_subagent_result` is never named — naming the tool we steer away from only
 * raises its salience. Two instructions were tried here and cut: "re-spawn with
 * a higher max_turns" (pushes a fresh multi-minute run to save one wasted tool
 * call) and, on `stopped`, "ask before restarting it" (restates the lead, and
 * presumes someone is present to ask — false under `pi -p`, in scheduled jobs,
 * and in any background-driven run). Nothing here can measure whether wording
 * improves parent behavior, so removing a false cue (which cannot induce new
 * behavior) and adding an instruction (which can) are not equally safe bets.
 * Don't add either back without a way to measure it.
 */
export function getForegroundOutcomeNote(record: NoteRecord): string {
  switch (record.status) {
    case "stopped":
      return record.stoppedByCaller
        ? " (stopped by you with stop_subagent — everything the agent produced is above; the task is unfinished)"
        : " (STOPPED BY THE USER — everything the agent produced is above; the task is unfinished)";
    case "aborted":
      return ` (aborted at the ${limitName(record)} — everything the agent produced is above; the task is unfinished)`;
    case "steered":
      return ` (wrapped up at the ${limitName(record)} — everything the agent produced is above; the task may be unfinished)`;
    default:
      return "";
  }
}

/** "turn limit" or "time limit", for the limit that steered or aborted the run. */
export function limitName(record: Pick<AgentRecord, "limit">): string {
  return record.limit === "time" ? "time limit" : "turn limit";
}

/**
 * Salvaged partial output of a failed run, as a labeled suffix for the error
 * surfaces (or "" if the run produced nothing). `record.result` is bounded to
 * the run's own turns, so this is never a stale earlier answer (#144).
 */
export function partialOutputSuffix(record: AgentRecord): string {
  const partial = record.result?.trim();
  return partial ? `\n\nPartial output before the failure:\n${partial}` : "";
}
