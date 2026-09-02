/**
 * Turn published activity frames into office lifecycle transitions.
 *
 * The office bridge plugin publishes `agent.activity` frames when a turn
 * starts and when it ends, wherever that turn was driven from — the desktop
 * app, Discord, the CLI, a kanban worker. Hermes3D already has a lifecycle for
 * runs it started itself, so the frames have to be reconciled rather than
 * replayed blindly:
 *
 *   - A run Hermes3D owns is skipped entirely; its own chat events already
 *     drive the character, and a second start would fight them.
 *   - Concurrent turns of the same profile share one visible run, so a profile
 *     stays running until the last of them ends.
 *   - A start that never gets an end (a crashed backend, a dropped socket)
 *     expires, so nobody is left spinning forever.
 *
 * ## Why a repeated start is not a duplicate
 *
 * The plugin repeats the start frame for a session that is still running, every
 * few seconds, carrying nothing but the session id. Between the opening frame
 * and the end that is the *only* signal the office gets, and plenty can clear a
 * desk in between: a static summary hydration overwrites the live agent state,
 * a browser reconnect starts from an empty one. So a repeat is treated as a
 * heartbeat that re-asserts the desk rather than a duplicate to swallow.
 *
 * ## Why the run id is per agent, not per session
 *
 * The office ignores a terminal phase whose run id does not match the run it is
 * currently tracking. One agent therefore gets one *visible* run id, minted by
 * whichever session lit the desk first and reused by every later frame — each
 * heartbeat, and the final end, whatever order the concurrent sessions happen
 * to finish in. A per-session id would let the last session end a run the
 * office never started, leaving the desk lit forever.
 *
 * Everything here is pure: the caller supplies `now` and emits the actions.
 */

/** A start with no end and no heartbeat after this long is treated as finished. */
const ACTIVITY_STALE_MS = 10 * 60_000;

const asString = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * Deterministic run id for an externally driven turn.
 *
 * It must be stable between the start and the end frame — the office state
 * machine ignores a terminal phase whose run id does not match the run it is
 * currently tracking.
 */
const buildActivityRunId = (agentId, sessionId) =>
  `office-activity:${agentId}:${sessionId || "main"}`;

/**
 * Track externally driven turns and decide what the office should be told.
 *
 * `plan()` returns one of:
 *   { action: "ignore" }
 *   { action: "start" | "end" | "error", agentId, sessionKey, runId, atMs }
 *
 * A `start` may be either the first one for an idle agent or a heartbeat
 * re-assertion for one already working; both carry the same visible run id, so
 * the caller can emit them identically.
 */
function createOfficeActivityTracker(options = {}) {
  const staleMs =
    typeof options.staleMs === "number" && options.staleMs > 0
      ? options.staleMs
      : ACTIVITY_STALE_MS;

  /**
   * agentId -> {
   *   runId,        the one visible run for this agent
   *   sessionKey,   the desk that run colours
   *   sessions,     Map<sessionId, { lastSeenAtMs }>
   * }
   */
  const activeByAgent = new Map();

  /** Shape every emitted decision the same way: no ids, no text, no payload. */
  const decide = (action, agent, agentId, atMs) => ({
    action,
    agentId,
    sessionKey: agent.sessionKey,
    runId: agent.runId,
    atMs,
  });

  const plan = (input) => {
    const agentId = asString(input?.agentId);
    const sessionKey = asString(input?.sessionKey);
    const phase = asString(input?.phase);
    if (!agentId || !sessionKey) return { action: "ignore" };
    if (phase !== "start" && phase !== "end" && phase !== "error") {
      return { action: "ignore" };
    }
    // A turn Hermes3D started itself already has a lifecycle; republishing it
    // would double up the start and race the real one to the end.
    if (input?.ownedByBridge) return { action: "ignore" };

    const sessionId = asString(input?.sessionId);
    const atMs = typeof input?.atMs === "number" ? input.atMs : Date.now();

    if (phase === "start") {
      const existing = activeByAgent.get(agentId);
      if (!existing) {
        // The transition into work: this session mints the visible run.
        const agent = {
          runId: buildActivityRunId(agentId, sessionId),
          sessionKey,
          sessions: new Map([[sessionId, { lastSeenAtMs: atMs }]]),
        };
        activeByAgent.set(agentId, agent);
        return decide("start", agent, agentId, atMs);
      }

      const tracked = existing.sessions.get(sessionId);
      existing.sessions.set(sessionId, { lastSeenAtMs: atMs });
      // A session we have not seen before is newly concurrent work. It joins
      // the existing visible run rather than opening a competing one, so the
      // character is not restarted underneath the turn already showing.
      if (!tracked) return { action: "ignore" };
      // A repeat for a session we are already tracking is the plugin's
      // heartbeat: re-assert the same run so anything that cleared the desk
      // mid-turn is corrected on the next beat.
      return decide("start", existing, agentId, atMs);
    }

    // Read without creating: an end for an agent we are not tracking must not
    // leave a phantom entry that makes it look busy.
    const agent = activeByAgent.get(agentId);
    // An end with no start of ours is not ours to apply — it would clear a run
    // Hermes3D is driving locally.
    if (!agent || !agent.sessions.has(sessionId)) return { action: "ignore" };
    agent.sessions.delete(sessionId);
    if (agent.sessions.size > 0) {
      // Another turn of the same profile is still going.
      return { action: "ignore" };
    }
    activeByAgent.delete(agentId);
    // Deliberately the visible run id, not this session's: the office only
    // accepts a terminal phase for the run it is actually tracking, and that
    // is the one the *first* session opened.
    return decide(phase === "error" ? "error" : "end", agent, agentId, atMs);
  };

  /**
   * Close out turns whose end frame never arrived.
   *
   * Freshness is measured from the last frame seen for a session, not from its
   * start, so a long turn that keeps heartbeating never expires underneath the
   * work it is reporting.
   */
  const prune = (nowMs) => {
    const expired = [];
    for (const [agentId, agent] of activeByAgent) {
      for (const [sessionId, entry] of agent.sessions) {
        if (nowMs - entry.lastSeenAtMs <= staleMs) continue;
        agent.sessions.delete(sessionId);
      }
      if (agent.sessions.size === 0) {
        activeByAgent.delete(agentId);
        expired.push(decide("end", agent, agentId, nowMs));
      }
    }
    return expired;
  };

  /** Which agents the office currently believes are working. */
  const activeAgentIds = () => [...activeByAgent.keys()];

  const reset = () => {
    activeByAgent.clear();
  };

  return { plan, prune, activeAgentIds, reset };
}

module.exports = {
  ACTIVITY_STALE_MS,
  buildActivityRunId,
  createOfficeActivityTracker,
};
