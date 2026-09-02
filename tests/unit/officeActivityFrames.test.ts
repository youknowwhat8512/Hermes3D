import { describe, expect, it } from "vitest";

const { MAX_ACTIVITY_AGE_MS, parseActivityFrame } = await import(
  "../../server/hermes-agent/office-speech"
);
const { createOfficeActivityTracker } = await import(
  "../../server/hermes-agent/office-activity"
);

const NOW = 1_700_000_000_000;

const frame = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    v: 1,
    kind: "agent.activity",
    profile: "clody",
    phase: "start",
    sessionId: "20260820_104030_9942e6",
    platform: "discord",
    atMs: NOW,
    ...overrides,
  });

describe("parseActivityFrame", () => {
  it("accepts a well-formed lifecycle frame", () => {
    expect(parseActivityFrame(frame(), NOW)).toEqual({
      profile: "clody",
      phase: "start",
      sessionId: "20260820_104030_9942e6",
      platform: "discord",
      atMs: NOW,
    });
  });

  it.each([["end"], ["error"]])("accepts the %s phase", (phase) => {
    expect(parseActivityFrame(frame({ phase }), NOW)?.phase).toBe(phase);
  });

  it.each([
    ["malformed json", "{not json"],
    ["a speech frame", JSON.stringify({ kind: "agent.turn", profile: "clody", text: "hi" })],
    ["a frame with no profile", frame({ profile: "" })],
    ["an unknown phase", frame({ phase: "thinking" })],
    ["a missing phase", frame({ phase: undefined })],
  ])("ignores %s", (_label, input) => {
    expect(parseActivityFrame(input, NOW)).toBeNull();
  });

  it("drops a lifecycle frame from a long-gone backlog", () => {
    expect(parseActivityFrame(frame({ atMs: NOW - MAX_ACTIVITY_AGE_MS - 1 }), NOW)).toBeNull();
  });

  it("keeps a start that took a while to arrive, unlike stale speech", () => {
    expect(parseActivityFrame(frame({ atMs: NOW - 30_000 }), NOW)?.phase).toBe("start");
  });
});

describe("office activity tracker", () => {
  const plan = (
    tracker: ReturnType<typeof createOfficeActivityTracker>,
    overrides: Record<string, unknown> = {},
  ) =>
    tracker.plan({
      agentId: "clody",
      sessionKey: "agent:clody:main",
      sessionId: "s-1",
      phase: "start",
      atMs: NOW,
      ownedByBridge: false,
      ...overrides,
    });

  it("turns an external start into a run the office can light up", () => {
    const tracker = createOfficeActivityTracker();
    expect(plan(tracker)).toMatchObject({
      action: "start",
      agentId: "clody",
      sessionKey: "agent:clody:main",
    });
  });

  it("pairs the end with the same run id as its start", () => {
    const tracker = createOfficeActivityTracker();
    const started = plan(tracker);
    const ended = plan(tracker, { phase: "end", atMs: NOW + 1_000 });
    expect(ended).toMatchObject({ action: "end" });
    expect((ended as { runId: string }).runId).toBe((started as { runId: string }).runId);
  });

  it("reports an error phase as an error, not a plain end", () => {
    const tracker = createOfficeActivityTracker();
    plan(tracker);
    expect(plan(tracker, { phase: "error" })).toMatchObject({ action: "error" });
  });

  it("leaves a run Hermes3D is already driving alone", () => {
    const tracker = createOfficeActivityTracker();
    expect(plan(tracker, { ownedByBridge: true })).toEqual({ action: "ignore" });
    // Nothing was tracked, so the matching end is not ours to apply either.
    expect(plan(tracker, { phase: "end", ownedByBridge: true })).toEqual({ action: "ignore" });
  });

  it("keeps a profile working until its last concurrent turn ends", () => {
    const tracker = createOfficeActivityTracker();
    expect(plan(tracker, { sessionId: "s-1" })).toMatchObject({ action: "start" });
    // A second turn of the same profile must not restart the character.
    expect(plan(tracker, { sessionId: "s-2" })).toEqual({ action: "ignore" });
    expect(plan(tracker, { sessionId: "s-1", phase: "end" })).toEqual({ action: "ignore" });
    expect(plan(tracker, { sessionId: "s-2", phase: "end" })).toMatchObject({ action: "end" });
  });

  it("does not let one profile's turn clear another's", () => {
    const tracker = createOfficeActivityTracker();
    plan(tracker, { agentId: "clody", sessionKey: "agent:clody:main" });
    expect(
      plan(tracker, { agentId: "findy", sessionKey: "agent:findy:main", phase: "end" }),
    ).toEqual({ action: "ignore" });
    expect(tracker.activeAgentIds()).toEqual(["clody"]);
  });

  it("ignores an end for a turn it never saw start", () => {
    const tracker = createOfficeActivityTracker();
    expect(plan(tracker, { phase: "end" })).toEqual({ action: "ignore" });
  });

  it.each([
    ["a missing agent", { agentId: "" }],
    ["a missing session key", { sessionKey: "" }],
    ["an unknown phase", { phase: "thinking" }],
  ])("ignores %s", (_label, overrides) => {
    const tracker = createOfficeActivityTracker();
    expect(plan(tracker, overrides)).toEqual({ action: "ignore" });
  });

  it("closes out a turn whose end frame never arrived", () => {
    const tracker = createOfficeActivityTracker({ staleMs: 1_000 });
    plan(tracker);
    expect(tracker.prune(NOW + 500)).toEqual([]);
    expect(tracker.prune(NOW + 2_000)).toMatchObject([
      { action: "end", agentId: "clody", sessionKey: "agent:clody:main" },
    ]);
    expect(tracker.activeAgentIds()).toEqual([]);
  });

  it("forgets everything on reset so a reconnect starts clean", () => {
    const tracker = createOfficeActivityTracker();
    plan(tracker);
    tracker.reset();
    expect(tracker.activeAgentIds()).toEqual([]);
    expect(plan(tracker, { phase: "end" })).toEqual({ action: "ignore" });
  });
});

/**
 * Keeping a direct-profile turn visibly working for its whole length.
 *
 * The office bridge plugin repeats the start frame for a session that is still
 * running, every few seconds, with no content on it. That repeat is the only
 * signal the office gets between the opening frame and the end, so it has to
 * survive as a re-assertion rather than being swallowed as a duplicate: a
 * static summary hydration or a browser reconnect can clear the desk mid-turn,
 * and the next heartbeat is what puts it back.
 *
 * The run id is what makes that safe. The office ignores a terminal phase whose
 * run id does not match the run it is tracking, so every frame for one agent —
 * the first start, each heartbeat, the last end — has to carry the same visible
 * run id, even across concurrent sessions that come and go in any order.
 */
describe("office activity heartbeat and stable visible run", () => {
  const plan = (
    tracker: ReturnType<typeof createOfficeActivityTracker>,
    overrides: Record<string, unknown> = {},
  ) =>
    tracker.plan({
      agentId: "clody",
      sessionKey: "agent:clody:main",
      sessionId: "s-1",
      phase: "start",
      atMs: NOW,
      ownedByBridge: false,
      ...overrides,
    });

  const runIdOf = (decision: unknown) => (decision as { runId: string }).runId;

  it("re-asserts the desk when the same session starts again", () => {
    const tracker = createOfficeActivityTracker();
    const started = plan(tracker);
    // The plugin's heartbeat: the same session, still working, seconds later.
    const refreshed = plan(tracker, { atMs: NOW + 5_000 });

    expect(refreshed).toMatchObject({
      action: "start",
      agentId: "clody",
      sessionKey: "agent:clody:main",
      atMs: NOW + 5_000,
    });
    // A new run id would leave the office tracking a run whose end never
    // matches, so the desk could never go back to idle.
    expect(runIdOf(refreshed)).toBe(runIdOf(started));
  });

  it("carries no content on a heartbeat refresh", () => {
    const tracker = createOfficeActivityTracker();
    plan(tracker);
    const refreshed = plan(tracker, { atMs: NOW + 5_000 });
    expect(Object.keys(refreshed as object).sort()).toEqual([
      "action",
      "agentId",
      "atMs",
      "runId",
      "sessionKey",
    ]);
  });

  it("keeps one visible run id when a second session joins", () => {
    const tracker = createOfficeActivityTracker();
    const started = plan(tracker, { sessionId: "s-1" });
    // A newly concurrent session must not open a competing visible run.
    expect(plan(tracker, { sessionId: "s-2", atMs: NOW + 1_000 })).toEqual({ action: "ignore" });
    // Its own heartbeat re-asserts the run that is already visible.
    const refreshed = plan(tracker, { sessionId: "s-2", atMs: NOW + 2_000 });
    expect(refreshed).toMatchObject({ action: "start" });
    expect(runIdOf(refreshed)).toBe(runIdOf(started));
  });

  it("ends on the visible run id even when the first session finished first", () => {
    const tracker = createOfficeActivityTracker();
    const started = plan(tracker, { sessionId: "s-1" });
    plan(tracker, { sessionId: "s-2", atMs: NOW + 1_000 });
    expect(plan(tracker, { sessionId: "s-1", phase: "end", atMs: NOW + 2_000 })).toEqual({
      action: "ignore",
    });
    const ended = plan(tracker, { sessionId: "s-2", phase: "end", atMs: NOW + 3_000 });

    expect(ended).toMatchObject({ action: "end", sessionKey: "agent:clody:main" });
    // The last session's own id would be a run the office never started.
    expect(runIdOf(ended)).toBe(runIdOf(started));
    expect(tracker.activeAgentIds()).toEqual([]);
  });

  it("reports the last session's failure on the visible run id", () => {
    const tracker = createOfficeActivityTracker();
    const started = plan(tracker, { sessionId: "s-1" });
    plan(tracker, { sessionId: "s-2", atMs: NOW + 1_000 });
    plan(tracker, { sessionId: "s-1", phase: "end", atMs: NOW + 2_000 });
    const failed = plan(tracker, { sessionId: "s-2", phase: "error", atMs: NOW + 3_000 });

    expect(failed).toMatchObject({ action: "error" });
    expect(runIdOf(failed)).toBe(runIdOf(started));
  });

  it("stays fresh for as long as heartbeats keep arriving", () => {
    const tracker = createOfficeActivityTracker({ staleMs: 1_000 });
    plan(tracker);
    expect(tracker.prune(NOW + 900)).toEqual([]);
    // Without a heartbeat this turn would expire at NOW + 1_000.
    plan(tracker, { atMs: NOW + 900 });
    expect(tracker.prune(NOW + 1_800)).toEqual([]);
    plan(tracker, { atMs: NOW + 1_800 });
    expect(tracker.prune(NOW + 2_700)).toEqual([]);
    expect(tracker.activeAgentIds()).toEqual(["clody"]);
  });

  it("expires once the heartbeats stop", () => {
    const tracker = createOfficeActivityTracker({ staleMs: 1_000 });
    const started = plan(tracker);
    plan(tracker, { atMs: NOW + 900 });
    const expired = tracker.prune(NOW + 2_500);

    expect(expired).toMatchObject([{ action: "end", agentId: "clody" }]);
    expect(runIdOf(expired[0])).toBe(runIdOf(started));
    expect(tracker.activeAgentIds()).toEqual([]);
  });

  it("goes idle on end and stays there, heartbeat or not", () => {
    const tracker = createOfficeActivityTracker({ staleMs: 1_000 });
    plan(tracker);
    expect(plan(tracker, { phase: "end", atMs: NOW + 500 })).toMatchObject({ action: "end" });
    expect(tracker.activeAgentIds()).toEqual([]);
    // Nothing is tracked, so pruning must not invent a second end.
    expect(tracker.prune(NOW + 10_000)).toEqual([]);
  });

  it("mints a fresh visible run for the next turn after going idle", () => {
    const tracker = createOfficeActivityTracker();
    const first = plan(tracker);
    plan(tracker, { phase: "end", atMs: NOW + 500 });
    const second = plan(tracker, { sessionId: "s-2", atMs: NOW + 1_000 });

    expect(second).toMatchObject({ action: "start" });
    expect(runIdOf(second)).not.toBe(runIdOf(first));
  });
});
