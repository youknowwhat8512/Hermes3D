// @vitest-environment node
/**
 * Coexistence between the board's desk colour and every other source.
 *
 * The kanban tracker only speaks on transitions, which is right for the board
 * itself but leaves a hole once a *different* source touches the same desk. A
 * chat turn drives the character through its own chat events and takes it back
 * to idle on the final frame; the office bridge plugin does the same around
 * model inference. Either of those finishing while a kanban card is still at
 * raw `running` leaves the desk grey for the rest of the run — the exact bug
 * the polling was added to fix, reappearing from the other direction.
 *
 * So the tracker has to notice when it yielded a desk and re-assert once the
 * other source lets go.
 */
import { describe, expect, it } from "vitest";

const { toKanbanRunningByAssignee } = await import("../../server/hermes-agent/kanban");
const { buildKanbanRunId, createKanbanActivityTracker } = await import(
  "../../server/hermes-agent/kanban-activity"
);

const NOW = 1_700_000_000_000;

const sessionKeys = { clody: "agent:clody:main", findy: "agent:findy:main" };

const observe = (
  tracker: ReturnType<typeof createKanbanActivityTracker>,
  runningByAgent: Record<string, string[]>,
  overrides: Record<string, unknown> = {},
) =>
  tracker.observe({
    runningByAgent,
    sessionKeyByAgentId: sessionKeys,
    atMs: NOW,
    ...overrides,
  });

describe("toKanbanRunningByAssignee raw status handling", () => {
  const card = (overrides: Record<string, unknown> = {}) => ({
    id: "t_1",
    assignee: "clody",
    status: "running",
    ...overrides,
  });

  it("reads the raw hermes status, never the collapsed office column", () => {
    // READ_STATUS maps running -> "working". If the selector ever read the
    // office column instead, a card literally stored as "working" would light
    // a desk for work the dispatcher has not started.
    expect(
      toKanbanRunningByAssignee({ columns: [{ tasks: [card({ status: "working" })] }] }).size,
    ).toBe(0);
  });

  it("does not collapse review or blocked into work in flight", () => {
    // Both land in the office's needs_attention column next to real work.
    for (const status of ["review", "blocked"]) {
      expect(
        toKanbanRunningByAssignee({ columns: [{ tasks: [card({ status })] }] }).size,
      ).toBe(0);
    }
  });

  it("deduplicates a card that appears in more than one column", () => {
    const grouped = toKanbanRunningByAssignee({
      columns: [{ tasks: [card()] }, { tasks: [card()] }],
    });
    expect(grouped.get("clody")).toEqual(["t_1"]);
  });

  it("survives a null column or a null task without throwing", () => {
    expect(
      toKanbanRunningByAssignee({ columns: [null, { tasks: [null, card()] }] }).get("clody"),
    ).toEqual(["t_1"]);
  });
});

describe("kanban activity yielding to another source", () => {
  it("re-lights the desk when a chat run ends while the card still runs", () => {
    const tracker = createKanbanActivityTracker();
    // The board lit this desk first, so the office is tracking the kanban run.
    expect(observe(tracker, { clody: ["t_1"] }).map((d) => d.action)).toEqual(["start"]);

    // A chat turn starts. It drives the character through its own chat events,
    // so the board must not fight it.
    expect(observe(tracker, { clody: ["t_1"] }, { busyAgentIds: ["clody"], atMs: NOW + 2_000 })).toEqual(
      [],
    );

    // The chat final takes the office to idle regardless of run id. The card
    // is still running, so the board has to take the desk back.
    expect(observe(tracker, { clody: ["t_1"] }, { atMs: NOW + 4_000 })).toEqual([
      {
        action: "start",
        agentId: "clody",
        sessionKey: "agent:clody:main",
        runId: buildKanbanRunId("clody"),
        atMs: NOW + 4_000,
      },
    ]);
  });

  it("re-asserts with the same run id it started with", () => {
    const tracker = createKanbanActivityTracker();
    const [started] = observe(tracker, { clody: ["t_1"] });
    observe(tracker, { clody: ["t_1"] }, { busyAgentIds: ["clody"], atMs: NOW + 1_000 });
    const [reasserted] = observe(tracker, { clody: ["t_1"] }, { atMs: NOW + 2_000 });
    // A fresh run id would leave the office tracking a run whose end never
    // matches, so the desk could never go idle again.
    expect(reasserted.runId).toBe(started.runId);
  });

  it("says nothing extra when nothing ever took the desk away", () => {
    const tracker = createKanbanActivityTracker();
    observe(tracker, { clody: ["t_1"] });
    expect(observe(tracker, { clody: ["t_1"] }, { atMs: NOW + 2_000 })).toEqual([]);
    expect(observe(tracker, { clody: ["t_1"] }, { atMs: NOW + 4_000 })).toEqual([]);
  });

  it("does not re-light a desk whose card finished during the other run", () => {
    const tracker = createKanbanActivityTracker();
    observe(tracker, { clody: ["t_1"] });
    observe(tracker, { clody: ["t_1"] }, { busyAgentIds: ["clody"], atMs: NOW + 1_000 });
    // The card left running while the chat turn still held the desk: there is
    // nothing to take back, and the end belongs to the run that is tracked.
    expect(observe(tracker, {}, { atMs: NOW + 2_000 }).map((d) => d.action)).toEqual(["end"]);
    expect(observe(tracker, {}, { atMs: NOW + 3_000 })).toEqual([]);
  });

  it("only re-asserts the desk that was actually yielded", () => {
    const tracker = createKanbanActivityTracker();
    observe(tracker, { clody: ["t_1"], findy: ["t_2"] });
    observe(
      tracker,
      { clody: ["t_1"], findy: ["t_2"] },
      { busyAgentIds: ["clody"], atMs: NOW + 1_000 },
    );
    expect(
      observe(tracker, { clody: ["t_1"], findy: ["t_2"] }, { atMs: NOW + 2_000 }).map(
        (d) => d.agentId,
      ),
    ).toEqual(["clody"]);
  });

  it("re-asserts only once per yield", () => {
    const tracker = createKanbanActivityTracker();
    observe(tracker, { clody: ["t_1"] });
    observe(tracker, { clody: ["t_1"] }, { busyAgentIds: ["clody"], atMs: NOW + 1_000 });
    expect(observe(tracker, { clody: ["t_1"] }, { atMs: NOW + 2_000 })).toHaveLength(1);
    expect(observe(tracker, { clody: ["t_1"] }, { atMs: NOW + 3_000 })).toEqual([]);
  });

  it("re-asserting carries no card content", () => {
    const tracker = createKanbanActivityTracker();
    observe(tracker, { clody: ["t_secret"] });
    observe(tracker, { clody: ["t_secret"] }, { busyAgentIds: ["clody"], atMs: NOW + 1_000 });
    const decisions = observe(tracker, { clody: ["t_secret"] }, { atMs: NOW + 2_000 });
    expect(JSON.stringify(decisions)).not.toContain("t_secret");
  });

  it("still holds the colour through an outage after a re-assert", () => {
    const tracker = createKanbanActivityTracker({ errorGraceMs: 30_000 });
    observe(tracker, { clody: ["t_1"] });
    observe(tracker, { clody: ["t_1"] }, { busyAgentIds: ["clody"], atMs: NOW + 1_000 });
    observe(tracker, { clody: ["t_1"] }, { atMs: NOW + 2_000 });
    expect(tracker.observeError(NOW + 20_000)).toEqual([]);
    expect(tracker.observeError(NOW + 40_000).map((d) => d.action)).toEqual(["end"]);
  });
});
