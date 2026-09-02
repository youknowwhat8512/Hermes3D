/**
 * The browser half of the kanban desk-colour path.
 *
 * The bridge emits board activity as an ordinary `agent` lifecycle frame with
 * a per-agent kanban run id, precisely so the office needs no second presence
 * path. That only holds if the frame really does survive normalisation and
 * drive the same agent state transition a chat-driven run does — including the
 * run-id pairing, which is what makes the terminal phase land instead of being
 * ignored.
 */
import { describe, expect, it } from "vitest";

import type { EventFrame } from "@/lib/gateway/GatewayClient";
import { normalizeGatewayEvent } from "@/lib/runtime/normalizeGatewayEvent";
import type { AgentState } from "@/features/agents/state/store";
import {
  planRuntimeAgentEvent,
  type RuntimeAgentWorkflowCommand,
  type RuntimeAgentWorkflowInput,
} from "@/features/agents/state/runtimeAgentEventWorkflow";
import type { AgentEventPayload } from "@/features/agents/state/runtimeEventBridge";
import { createRuntimeTerminalState } from "@/features/agents/state/runtimeTerminalWorkflow";

const { buildKanbanRunId } = await import("../../server/hermes-agent/kanban-activity");

const KANBAN_RUN_ID = buildKanbanRunId("clody") as string;
const SESSION_KEY = "agent:clody:main";

/** Exactly the frame `emitActivityLifecycle` puts on the wire for the board. */
const kanbanFrame = (phase: string): EventFrame =>
  ({
    type: "event",
    event: "agent",
    seq: 1,
    payload: {
      runId: KANBAN_RUN_ID,
      sessionKey: SESSION_KEY,
      stream: "lifecycle",
      data: { phase, text: "", source: "kanban-activity" },
    },
  }) as unknown as EventFrame;

const createAgent = (overrides?: Partial<AgentState>): AgentState =>
  ({
    agentId: "clody",
    name: "Clody",
    sessionKey: SESSION_KEY,
    status: "idle",
    sessionCreated: true,
    awaitingUserInput: false,
    hasUnseenActivity: false,
    outputLines: [],
    lastResult: null,
    lastDiff: null,
    runId: null,
    runStartedAt: null,
    streamText: null,
    thinkingTrace: null,
    latestOverride: null,
    latestOverrideKind: null,
    lastAssistantMessageAt: null,
    lastActivityAt: null,
    latestPreview: null,
    lastUserMessage: null,
    draft: "",
    sessionSettingsSynced: true,
    historyLoadedAt: null,
    historyFetchLimit: null,
    historyFetchedCount: null,
    historyMaybeTruncated: false,
    toolCallingEnabled: true,
    showThinkingTraces: true,
    model: "openai/gpt-5",
    thinkingLevel: "medium",
    avatarSeed: "seed-1",
    avatarUrl: null,
    ...(overrides ?? {}),
  }) as AgentState;

const plan = (
  phase: string,
  agent: AgentState,
  overrides: Partial<RuntimeAgentWorkflowInput> = {},
) =>
  planRuntimeAgentEvent({
    payload: (kanbanFrame(phase).payload as unknown) as AgentEventPayload,
    agent,
    activeRunId: agent.runId?.trim() || null,
    nowMs: 5_000,
    runtimeTerminalState: createRuntimeTerminalState(),
    hasChatEvents: false,
    hasPendingFallbackTimer: false,
    previousThinkingRaw: null,
    previousAssistantRaw: null,
    thinkingStartedAtMs: null,
    historyRefreshRequested: false,
    lifecycleFallbackDelayMs: 0,
    ...overrides,
  });

const lifecycleCommand = (commands: RuntimeAgentWorkflowCommand[]) =>
  commands.find((command) => command.kind === "applyLifecycleDecision") as
    | Extract<RuntimeAgentWorkflowCommand, { kind: "applyLifecycleDecision" }>
    | undefined;

describe("normalizeGatewayEvent for board activity", () => {
  it("recognises a kanban lifecycle frame as a run lifecycle event", () => {
    expect(normalizeGatewayEvent(kanbanFrame("start"))).toMatchObject({
      type: "run.lifecycle",
      phase: "start",
      runId: KANBAN_RUN_ID,
      sessionKey: SESSION_KEY,
    });
  });

  it("carries the end phase through with the same run id", () => {
    expect(normalizeGatewayEvent(kanbanFrame("end"))).toMatchObject({
      type: "run.lifecycle",
      phase: "end",
      runId: KANBAN_RUN_ID,
    });
  });

  it("does not smuggle any card content into the normalized event", () => {
    // The bridge sends an empty text on purpose; assert the whole frame is
    // free of anything resembling a task payload.
    const raw = JSON.stringify(normalizeGatewayEvent(kanbanFrame("start")));
    expect(raw).not.toContain("title");
    expect(raw).not.toContain("body");
    expect(raw).toContain("kanban-activity");
  });
});

describe("planRuntimeAgentEvent for board activity", () => {
  it("takes an idle desk to running on the board's start", () => {
    const { commands } = plan("start", createAgent());
    expect(lifecycleCommand(commands)?.transitionPatch).toMatchObject({
      status: "running",
      runId: KANBAN_RUN_ID,
    });
  });

  it("returns the desk to idle on the board's end", () => {
    const agent = createAgent({ status: "running", runId: KANBAN_RUN_ID });
    expect(lifecycleCommand(plan("end", agent).commands)?.transitionPatch).toMatchObject({
      status: "idle",
      runId: null,
    });
  });

  it("ignores a board end for a run the office is not tracking", () => {
    // This is why the run id has to be deterministic per agent: a mismatched
    // id here would silently drop the transition.
    const agent = createAgent({ status: "running", runId: "some-other-run" });
    expect(lifecycleCommand(plan("end", agent).commands)).toBeUndefined();
  });

  it("lets a chat run keep the desk when a stale board end arrives", () => {
    const agent = createAgent({ status: "running", runId: "chat-run" });
    const { commands } = plan("end", agent);
    expect(lifecycleCommand(commands)).toBeUndefined();
    // The desk stays exactly as the chat run left it.
    expect(agent.status).toBe("running");
  });

  it("a board start refreshes history when no chat events backed the run", () => {
    const { commands } = plan("start", createAgent());
    // A kanban worker produces no chat stream at all, so the office has to go
    // and fetch what happened rather than wait for deltas that never come.
    expect(commands.map((command) => command.kind)).toContain("scheduleHistoryRefresh");
  });

  it("never appends card text to the transcript", () => {
    const { commands } = plan("start", createAgent());
    expect(commands.map((command) => command.kind)).not.toContain("appendToolLines");
    // The run id legitimately carries the `kanban-activity:` prefix; what must
    // never appear is anything from the card itself.
    const raw = JSON.stringify(commands);
    for (const cardContent of ["title", "body", "workspace", "t_53b4e914"]) {
      expect(raw).not.toContain(cardContent);
    }
  });
});
