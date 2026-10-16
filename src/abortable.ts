/**
 * abortable.ts — race a promise against an AbortSignal without cancelling the
 * underlying work.
 *
 * Used by the `get_subagent_result` wait paths (top-level and nested): pressing
 * Esc cancels only the caller's wait; the background child keeps running and its
 * result stays unconsumed. The listener is removed on every settle path so the
 * signal accumulates no handlers, and a late settlement of the wrapped promise
 * after an abort is absorbed as a no-op (no unhandled rejection).
 */

/** Await a promise until it settles or the caller cancels, without aborting the underlying work. */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

/**
 * Wait for a queued or running record to settle, for at most `timeoutMs` when
 * given. Resolves `true` when the timeout ran out first. Only the wait ends —
 * the agent keeps running. Rejects with the signal's reason when the caller
 * cancels. Queued records have no promise until they start, so they are polled.
 */
export async function waitForRecord(
  record: { status: string; stopping?: boolean; promise?: Promise<unknown> },
  /** The manager's `awaitStartup` for this record: a worktree copy runs before `promise` exists. */
  startup: () => Promise<unknown>,
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
  pollMs: number,
): Promise<boolean> {
  const timeout = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
  const combined = timeout && signal ? AbortSignal.any([signal, timeout]) : timeout ?? signal;
  try {
    while (record.status === "queued") {
      await abortable(new Promise<void>(resolve => setTimeout(resolve, pollMs)), combined);
    }
    await abortable(startup().catch(() => {}), combined);
    if (record.promise) await abortable(record.promise, combined);
    return false;
  } catch (err) {
    if (timeout?.aborted && !signal?.aborted) return true;
    throw err;
  }
}
