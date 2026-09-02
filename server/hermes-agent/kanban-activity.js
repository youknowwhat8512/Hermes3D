/**
 * Turn the hermes kanban board's `running` rows into office lifecycle
 * transitions.
 *
 * A kanban worker never publishes chat traffic to Hermes3D — the dispatcher
 * spawns it out of band — so a desk assigned to a working profile stayed grey
 * for the whole run. The board itself is the signal: canonical raw status
 * `running` means that profile's worker is executing tools, files, and tests
 * right now, and the desk must stay green for exactly that long.
 *
 * The reconciliation rules are deliberately narrow, because a wrong decision
 * here leaves a character stuck in the wrong colour:
 *
 *   - Only `running` counts. Every other status (ready, blocked, review,
 *     done, …) is queued or finished work, not work in flight.
 *   - Rows are grouped by assignee, so a profile with several running cards
 *     goes green once and comes back to idle only when the last one leaves
 *     `running`.
 *   - An assignee that is not one of this connection's agents is ignored
 *     rather than guessed at.
 *   - A profile the bridge or the published-activity feed is already driving
 *     is left alone: it is green already, and a second start would fight the
 *     lifecycle that owns it. That yield has to be remembered, though: those
 *     lifecycles end on their own schedule (a chat final, a `post_llm_call`)
 *     while the card is still `running`, and the office takes the desk to idle
 *     when they do. So the board re-asserts its own run the moment the other
 *     source lets go, which is what keeps a desk green across the minutes of
 *     tool and test execution that sit outside model inference.
 *   - A poll that fails keeps the current colour for a bounded grace window,
 *     so one flaky request cannot blink the whole office to idle; past that,
 *     everything is closed out rather than left spinning.
 *
 * Everything here is pure: the caller supplies `now`, the board snapshot, and
 * emits the resulting actions.
 */

/** How often the board is polled; fast enough to feel live, cheap enough to loop. */
const KANBAN_ACTIVITY_POLL_INTERVAL_MS = 2_000;

/** How long a desk keeps its colour while the board cannot be read. */
const KANBAN_ACTIVITY_ERROR_GRACE_MS = 30_000;

const asString = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * Deterministic run id for a profile's kanban work.
 *
 * It must be stable between the start and the end transition — the office
 * ignores a terminal phase whose run id does not match the run it is tracking
 * — and distinct per agent so two desks cannot clear each other.
 */
const buildKanbanRunId = (agentId) => `kanban-activity:${agentId}`;

/** Normalise `agentId -> taskIds` input from a Map or a plain object. */
const toEntries = (runningByAgent) => {
  if (runningByAgent instanceof Map) return [...runningByAgent.entries()];
  if (runningByAgent && typeof runningByAgent === "object") {
    return Object.entries(runningByAgent);
  }
  return [];
};

const toIdSet = (taskIds) => {
  const ids = new Set();
  for (const taskId of Array.isArray(taskIds) ? taskIds : []) {
    const id = asString(taskId);
    if (id) ids.add(id);
  }
  return ids;
};

const toStringSet = (values) => {
  const out = new Set();
  for (const value of values ?? []) {
    const text = asString(value);
    if (text) out.add(text);
  }
  return out;
};

/**
 * Track which profiles the board says are working.
 *
 * `observe()` and `observeError()` both return a list of actions in the same
 * shape the published-activity tracker produces, so the bridge emits them
 * through one path:
 *
 *   { action: "start" | "end", agentId, sessionKey, runId, atMs }
 */
function createKanbanActivityTracker(options = {}) {
  const graceMs =
    typeof options.errorGraceMs === "number" && options.errorGraceMs >= 0
      ? options.errorGraceMs
      : KANBAN_ACTIVITY_ERROR_GRACE_MS;

  /** agentId -> { sessionKey, runId, taskIds: Set<string>, yielded: boolean } */
  const activeByAgent = new Map();
  /** When the board last read cleanly; null until the first success. */
  let lastReadAtMs = null;

  const endAll = (atMs) => {
    const decisions = [];
    for (const [agentId, entry] of activeByAgent) {
      decisions.push({
        action: "end",
        agentId,
        sessionKey: entry.sessionKey,
        runId: entry.runId,
        atMs,
      });
    }
    activeByAgent.clear();
    return decisions;
  };

  /**
   * Reconcile one board snapshot.
   *
   * @param {{
   *   runningByAgent?: Map<string, string[]> | Record<string, string[]>,
   *   sessionKeyByAgentId?: Map<string, string> | Record<string, string>,
   *   busyAgentIds?: Iterable<string>,
   *   atMs?: number,
   * }} input
   */
  const observe = (input = {}) => {
    const atMs = typeof input.atMs === "number" ? input.atMs : Date.now();
    const sessionKeys = new Map(
      toEntries(input.sessionKeyByAgentId).map(([agentId, key]) => [
        asString(agentId),
        asString(key),
      ]),
    );
    // Already lit by a run this connection owns or by the published-activity
    // feed; the board must not start a competing run for the same desk.
    const busy = toStringSet(input.busyAgentIds);

    /** agentId -> Set<taskId> the board reports as running right now. */
    const desired = new Map();
    for (const [rawAgentId, taskIds] of toEntries(input.runningByAgent)) {
      const agentId = asString(rawAgentId);
      if (!agentId) continue;
      const sessionKey = sessionKeys.get(agentId);
      // An assignee with no agent on this connection is somebody else's
      // worker; there is no desk to colour.
      if (!sessionKey) continue;
      const ids = toIdSet(taskIds);
      if (ids.size === 0) continue;
      desired.set(agentId, { sessionKey, taskIds: ids });
    }

    const decisions = [];

    // positive -> zero: the last running card left `running`.
    for (const [agentId, entry] of [...activeByAgent]) {
      if (desired.has(agentId)) continue;
      activeByAgent.delete(agentId);
      decisions.push({
        action: "end",
        agentId,
        sessionKey: entry.sessionKey,
        runId: entry.runId,
        atMs,
      });
    }

    for (const [agentId, entry] of desired) {
      const tracked = activeByAgent.get(agentId);
      if (tracked) {
        // Still working: remember the current card set so a later poll can
        // tell "different task" from "no task".
        tracked.taskIds = entry.taskIds;
        if (busy.has(agentId)) {
          // Another lifecycle has the desk. It will end on its own schedule
          // while this card keeps running, so remember that the board owes
          // this desk a start once that happens.
          tracked.yielded = true;
          continue;
        }
        if (!tracked.yielded) continue;
        // The other source let go and the card is still running, so the desk
        // has just been taken to idle underneath us. Re-assert the original
        // run id — a fresh one would leave the office tracking a run whose
        // end never matches, and the desk could never go idle again.
        tracked.yielded = false;
        decisions.push({
          action: "start",
          agentId,
          sessionKey: tracked.sessionKey,
          runId: tracked.runId,
          atMs,
        });
        continue;
      }
      if (busy.has(agentId)) continue;
      // zero -> positive: this profile just started kanban work.
      const runId = buildKanbanRunId(agentId);
      activeByAgent.set(agentId, {
        sessionKey: entry.sessionKey,
        runId,
        taskIds: entry.taskIds,
        yielded: false,
      });
      decisions.push({
        action: "start",
        agentId,
        sessionKey: entry.sessionKey,
        runId,
        atMs,
      });
    }

    lastReadAtMs = atMs;
    return decisions;
  };

  /**
   * A poll failed.
   *
   * Returns nothing while the failure is still inside the grace window — a
   * restarting backend or one dropped request is not evidence that the work
   * stopped — and closes every tracked profile out once it is not.
   */
  const observeError = (atMs = Date.now()) => {
    if (activeByAgent.size === 0) return [];
    if (lastReadAtMs !== null && atMs - lastReadAtMs <= graceMs) return [];
    return endAll(atMs);
  };

  /** Which agents the board currently says are working. */
  const activeAgentIds = () => [...activeByAgent.keys()];

  /** The running card ids behind an agent's colour, for diagnostics and tests. */
  const activeTaskIds = (agentId) => [
    ...(activeByAgent.get(asString(agentId))?.taskIds ?? []),
  ];

  const reset = () => {
    activeByAgent.clear();
    lastReadAtMs = null;
  };

  return { observe, observeError, activeAgentIds, activeTaskIds, reset };
}

module.exports = {
  KANBAN_ACTIVITY_ERROR_GRACE_MS,
  KANBAN_ACTIVITY_POLL_INTERVAL_MS,
  buildKanbanRunId,
  createKanbanActivityTracker,
};
