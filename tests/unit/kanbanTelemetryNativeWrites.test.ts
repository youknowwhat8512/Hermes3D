import { describe, expect, it } from "vitest";

import type { AgentState } from "@/features/agents/state/store";
import type { TaskBoardCard } from "@/features/office/tasks/types";
import {
  isObservationalLifecycleFrame,
  planAgentLifecycleCardEffect,
} from "@/features/office/tasks/useTaskBoardController";

/**
 * Regression guard for the kanban feedback loop.
 *
 * `server/hermes-agent/kanban-activity.js` polls the board and synthesises
 * `agent` lifecycle frames (`start` / re-asserted `start` / `end`) purely so a
 * desk can be coloured while a dispatcher-spawned worker runs. Those frames
 * used to reach the same board ingestion path as a real chat run, which picked
 * any unfinished card of that assignee with no run id and PATCHed the native
 * Hermes task to `working`, then to `done` when the desk went idle — killing
 * live workers and marking cards complete with no run and no artifacts.
 *
 * Display telemetry must never produce an authoritative task write.
 */

const AGENT: AgentState = {
  agentId: "ian",
  name: "ian",
  sessionKey: "agent:ian:main",
  awaitingUserInput: false,
} as AgentState;

const makeTestCard = (overrides: Partial<TaskBoardCard> = {}): TaskBoardCard => ({
  id: "kanban:t_74a906d7",
  title: "Native kanban card",
  description: "",
  status: "inbox",
  source: "hermes_event",
  sourceEventId: null,
  assignedAgentId: "ian",
  createdAt: "2026-09-13T00:00:00.000Z",
  updatedAt: "2026-09-13T00:00:00.000Z",
  playbookJobId: null,
  runId: null,
  channel: null,
  externalThreadId: null,
  lastActivityAt: null,
  notes: [],
  isArchived: false,
  isInferred: false,
  model: null,
  skills: [],
  subagentCount: 0,
  scheduledFor: null,
  learnedSkill: false,
  ...overrides,
});

const telemetryFrame = (
  phase: "start" | "end" | "error",
  source = "kanban-activity",
  runId = "kanban-activity:ian",
) => ({
  type: "event" as const,
  event: "agent",
  payload: {
    runId,
    sessionKey: "agent:ian:main",
    stream: "lifecycle",
    data: { phase, text: "", source },
  },
});

const realRunFrame = (phase: "start" | "end" | "error", runId = "run-1") => ({
  type: "event" as const,
  event: "agent",
  payload: {
    runId,
    sessionKey: "agent:ian:main",
    stream: "lifecycle",
    data: { phase, text: "" },
  },
});

describe("observational lifecycle telemetry", () => {
  it("recognises board-poll and published-activity frames", () => {
    expect(isObservationalLifecycleFrame(telemetryFrame("start"))).toBe(true);
    expect(
      isObservationalLifecycleFrame(telemetryFrame("end", "office-activity", "office:ian")),
    ).toBe(true);
    // Even without the source tag, the kanban tracker's run id is diagnostic.
    expect(
      isObservationalLifecycleFrame(telemetryFrame("start", "", "kanban-activity:ian")),
    ).toBe(true);
    expect(isObservationalLifecycleFrame(realRunFrame("start"))).toBe(false);
  });

  it("produces no card effect for a synthetic start/reassert/end cycle", () => {
    const cards = [makeTestCard()];
    for (const phase of ["start", "start", "end"] as const) {
      expect(
        planAgentLifecycleCardEffect({
          event: telemetryFrame(phase),
          agents: [AGENT],
          cards,
        }),
      ).toBeNull();
    }
  });

  it("never adopts a no-runId card while the agent has a genuinely running task", () => {
    const cards = [
      makeTestCard({ id: "kanban:t_8c23d6e8", status: "inbox", runId: null }),
      makeTestCard({
        id: "kanban:t_74a906d7",
        status: "working",
        runId: "kanban-run-1",
        updatedAt: "2026-09-13T01:00:00.000Z",
      }),
    ];
    expect(
      planAgentLifecycleCardEffect({
        event: telemetryFrame("start"),
        agents: [AGENT],
        cards,
      }),
    ).toBeNull();
    expect(
      planAgentLifecycleCardEffect({
        event: telemetryFrame("end"),
        agents: [AGENT],
        cards,
      }),
    ).toBeNull();
  });

  it("never mints an inferred card from telemetry", () => {
    expect(
      planAgentLifecycleCardEffect({
        event: telemetryFrame("start"),
        agents: [{ ...AGENT, lastUserMessage: "Please fix the board." } as AgentState],
        cards: [],
      }),
    ).toBeNull();
  });

  it("leaves native kanban cards alone even for a real run with no run id link", () => {
    expect(
      planAgentLifecycleCardEffect({
        event: realRunFrame("end"),
        agents: [AGENT],
        cards: [makeTestCard()],
      }),
    ).toBeNull();
  });

  it("never writes a native kanban card from an agent frame, even on run-id match", () => {
    // A parallel guard in selectAgentEventCard keeps every `kanban:` card out
    // of generic agent-event binding: the dispatcher owns that row's status.
    const linked = makeTestCard({ id: "kanban:t_74a906d7", runId: "run-1" });
    expect(
      planAgentLifecycleCardEffect({
        event: realRunFrame("start"),
        agents: [AGENT],
        cards: [linked],
      }),
    ).toBeNull();
  });

  it("still tracks a real run against a local chat-derived card", () => {
    const local = makeTestCard({
      id: "chat:agent:ian:main:8",
      runId: null,
      status: "inbox",
    });
    expect(
      planAgentLifecycleCardEffect({
        event: realRunFrame("end"),
        agents: [AGENT],
        cards: [local],
      }),
    ).toEqual(
      expect.objectContaining({
        kind: "update",
        cardId: "chat:agent:ian:main:8",
        patch: expect.objectContaining({ status: "done" }),
      }),
    );
  });

  it("produces no effect for telemetry even when a matching run-id card exists", () => {
    const inferred = makeTestCard({
      id: "run:agent:ian:main:kanban-activity:ian",
      runId: "kanban-activity:ian",
      isInferred: true,
      status: "working",
    });
    expect(
      planAgentLifecycleCardEffect({
        event: telemetryFrame("end"),
        agents: [AGENT],
        cards: [inferred],
      }),
    ).toBeNull();
  });
});
