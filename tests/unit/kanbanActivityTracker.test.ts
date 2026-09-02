// @vitest-environment node
import { describe, expect, it } from "vitest";

const { toKanbanRunningByAssignee } = await import("../../server/hermes-agent/kanban");
const { buildKanbanRunId, createKanbanActivityTracker } = await import(
  "../../server/hermes-agent/kanban-activity"
);

const NOW = 1_700_000_000_000;

type Task = Record<string, unknown>;

const board = (tasks: Task[]) => ({
  columns: [{ id: null, tasks }],
});

const task = (overrides: Task = {}): Task => ({
  id: "t_1",
  title: "Ship the release",
  body: "Cut the tag and publish.",
  assignee: "clody",
  status: "running",
  workspace_path: "/private/workspace/secret",
  ...overrides,
});

describe("toKanbanRunningByAssignee", () => {
  it("groups running cards by the profile executing them", () => {
    const grouped = toKanbanRunningByAssignee(
      board([
        task({ id: "t_1", assignee: "clody" }),
        task({ id: "t_2", assignee: "clody" }),
        task({ id: "t_3", assignee: "findy" }),
      ]),
    );
    expect([...grouped.entries()]).toEqual([
      ["clody", ["t_1", "t_2"]],
      ["findy", ["t_3"]],
    ]);
  });

  it.each([["ready"], ["todo"], ["blocked"], ["review"], ["done"], ["archived"]])(
    "does not treat %s as work in flight",
    (status) => {
      expect(toKanbanRunningByAssignee(board([task({ status })])).size).toBe(0);
    },
  );

  it("skips a running card with nobody assigned to it", () => {
    expect(toKanbanRunningByAssignee(board([task({ assignee: "  " })])).size).toBe(0);
  });

  it("tolerates a board with no columns at all", () => {
    expect(toKanbanRunningByAssignee(undefined).size).toBe(0);
    expect(toKanbanRunningByAssignee({ columns: "nope" }).size).toBe(0);
  });

  it("carries nothing but the assignee and the card id", () => {
    const grouped = toKanbanRunningByAssignee(board([task()]));
    // Titles, bodies, and workspace paths must not ride a desk-colour feed.
    expect(JSON.stringify([...grouped])).toBe('[["clody",["t_1"]]]');
  });
});

describe("kanban activity tracker", () => {
  const sessionKeys = {
    clody: "agent:clody:main",
    findy: "agent:findy:main",
  };

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

  it("turns a running card into a start the office can light up", () => {
    const tracker = createKanbanActivityTracker();
    expect(observe(tracker, { clody: ["t_1"] })).toEqual([
      {
        action: "start",
        agentId: "clody",
        sessionKey: "agent:clody:main",
        runId: buildKanbanRunId("clody"),
        atMs: NOW,
      },
    ]);
  });

  it("lights up work that was already running when the office connected", () => {
    const tracker = createKanbanActivityTracker();
    // The very first read is a snapshot, not a change feed — a worker mid-run
    // has no zero->positive edge to observe, so it must still start.
    expect(observe(tracker, { clody: ["t_1"] }).map((d) => d.action)).toEqual(["start"]);
  });

  it("says nothing while the same card keeps running", () => {
    const tracker = createKanbanActivityTracker();
    observe(tracker, { clody: ["t_1"] });
    expect(observe(tracker, { clody: ["t_1"] }, { atMs: NOW + 2_000 })).toEqual([]);
    expect(observe(tracker, { clody: ["t_1"] }, { atMs: NOW + 4_000 })).toEqual([]);
  });

  it("pairs the end with the same run id as its start", () => {
    const tracker = createKanbanActivityTracker();
    const [started] = observe(tracker, { clody: ["t_1"] });
    const [ended] = observe(tracker, {}, { atMs: NOW + 1_000 });
    expect(ended).toMatchObject({ action: "end", agentId: "clody", atMs: NOW + 1_000 });
    expect(ended.runId).toBe(started.runId);
  });

  it("keeps a profile working until its last running card is done", () => {
    const tracker = createKanbanActivityTracker();
    expect(observe(tracker, { clody: ["t_1"] }).map((d) => d.action)).toEqual(["start"]);
    // A second card for the same profile must not restart the character.
    expect(observe(tracker, { clody: ["t_1", "t_2"] })).toEqual([]);
    expect(observe(tracker, { clody: ["t_2"] })).toEqual([]);
    expect(tracker.activeTaskIds("clody")).toEqual(["t_2"]);
    expect(observe(tracker, {}).map((d) => d.action)).toEqual(["end"]);
  });

  it("does not let one profile's card clear another's", () => {
    const tracker = createKanbanActivityTracker();
    observe(tracker, { clody: ["t_1"], findy: ["t_2"] });
    expect(observe(tracker, { clody: ["t_1"] })).toEqual([
      expect.objectContaining({ action: "end", agentId: "findy" }),
    ]);
    expect(tracker.activeAgentIds()).toEqual(["clody"]);
  });

  it("ignores an assignee that is not an agent on this connection", () => {
    const tracker = createKanbanActivityTracker();
    expect(observe(tracker, { stranger: ["t_9"] })).toEqual([]);
    expect(tracker.activeAgentIds()).toEqual([]);
  });

  it("leaves a desk another lifecycle is already driving alone", () => {
    const tracker = createKanbanActivityTracker();
    expect(observe(tracker, { clody: ["t_1"] }, { busyAgentIds: ["clody"] })).toEqual([]);
    expect(tracker.activeAgentIds()).toEqual([]);
    // Once that other run finishes, the board takes the desk over itself.
    expect(observe(tracker, { clody: ["t_1"] }).map((d) => d.action)).toEqual(["start"]);
  });

  it("holds the colour through a brief board outage", () => {
    const tracker = createKanbanActivityTracker({ errorGraceMs: 30_000 });
    observe(tracker, { clody: ["t_1"] });
    expect(tracker.observeError(NOW + 10_000)).toEqual([]);
    expect(tracker.observeError(NOW + 29_000)).toEqual([]);
    expect(tracker.activeAgentIds()).toEqual(["clody"]);
  });

  it("closes everything out when the board stays unreadable", () => {
    const tracker = createKanbanActivityTracker({ errorGraceMs: 30_000 });
    observe(tracker, { clody: ["t_1"], findy: ["t_2"] });
    expect(tracker.observeError(NOW + 31_000).map((d) => d.action)).toEqual(["end", "end"]);
    expect(tracker.activeAgentIds()).toEqual([]);
    // Already closed out: a further failure must not re-emit the same ends.
    expect(tracker.observeError(NOW + 60_000)).toEqual([]);
  });

  it("restarts the grace window after each clean read", () => {
    const tracker = createKanbanActivityTracker({ errorGraceMs: 30_000 });
    observe(tracker, { clody: ["t_1"] });
    expect(tracker.observeError(NOW + 20_000)).toEqual([]);
    observe(tracker, { clody: ["t_1"] }, { atMs: NOW + 25_000 });
    expect(tracker.observeError(NOW + 50_000)).toEqual([]);
  });

  it("has nothing to close out when no desk is lit", () => {
    const tracker = createKanbanActivityTracker({ errorGraceMs: 0 });
    expect(tracker.observeError(NOW)).toEqual([]);
  });

  it("forgets everything on reset so a reconnect starts clean", () => {
    const tracker = createKanbanActivityTracker();
    observe(tracker, { clody: ["t_1"] });
    tracker.reset();
    expect(tracker.activeAgentIds()).toEqual([]);
    // A reset tracker re-lights the desk rather than assuming it is still on.
    expect(observe(tracker, { clody: ["t_1"] }).map((d) => d.action)).toEqual(["start"]);
  });
});
