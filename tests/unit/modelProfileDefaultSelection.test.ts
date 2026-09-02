import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { AgentChatPanel } from "@/features/agents/components/AgentChatPanel";
import type { AgentState } from "@/features/agents/state/store";
import type { GatewayModelChoice } from "@/lib/gateway/models";
import { applySessionSettingMutation } from "@/features/agents/state/sessionSettingsMutations";
import { applyOfficeModelSelection } from "@/features/office/operations/officeSessionSettings";
import type { GatewayClient } from "@/lib/gateway/GatewayClient";

const createAgent = (): AgentState => ({
  agentId: "agent-1",
  name: "Agent One",
  sessionKey: "agent:agent-1:main",
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
});

const models: GatewayModelChoice[] = [
  { provider: "openai", id: "gpt-5", name: "gpt-5", reasoning: true },
  { provider: "anthropic", id: "claude-opus-4-5", name: "claude-opus-4-5", reasoning: true },
];

describe("model dropdown communicates that the pick is a profile default", () => {
  afterEach(() => {
    cleanup();
  });

  it("labels the model select in Korean as a permanent profile default", () => {
    render(
      createElement(AgentChatPanel, {
        agent: createAgent(),
        isSelected: true,
        canSend: true,
        models,
        stopBusy: false,
        onLoadMoreHistory: vi.fn(),
        onOpenSettings: vi.fn(),
        onRename: vi.fn(async () => true),
        onModelChange: vi.fn(),
        onThinkingChange: vi.fn(),
        onDraftChange: vi.fn(),
        onSend: vi.fn(),
        onStopRun: vi.fn(),
        onAvatarShuffle: vi.fn(),
      })
    );

    const select = screen.getByLabelText("Model");
    // The user has to know a pick here outlives this session: it becomes the
    // profile's default for new sessions and other clients too.
    const tooltip = screen.getByRole("tooltip", { name: /프로필 기본 모델/ });
    expect(tooltip).toBeInTheDocument();
    expect(tooltip.textContent).toContain("새 세션");
    expect(select.getAttribute("title")).toContain("프로필 기본 모델");
  });
});

describe("session setting mutation with profile-scoped model results", () => {
  it("keeps the persisted profile model reported by the gateway", async () => {
    const dispatch = vi.fn();
    const client = {
      call: vi.fn(async () => ({
        ok: true,
        key: "agent:agent-1:main",
        resolved: {
          model: "claude-opus-4-5",
          modelProvider: "anthropic",
          scope: "profile",
          profile: "findy",
        },
      })),
    } as unknown as GatewayClient;

    await applySessionSettingMutation({
      agents: [{ agentId: "agent-1", sessionCreated: true, model: "openai/gpt-5" }],
      dispatch,
      client,
      agentId: "agent-1",
      sessionKey: "agent:agent-1:main",
      field: "model",
      value: "anthropic/claude-opus-4-5",
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "updateAgent",
      agentId: "agent-1",
      patch: {
        model: "anthropic/claude-opus-4-5",
        sessionSettingsSynced: true,
        sessionCreated: true,
      },
    });
    // A durable write deserves a visible confirmation, not a silent swap.
    const lines = dispatch.mock.calls
      .map((entry) => entry[0])
      .filter(
        (action): action is { type: "appendOutput"; agentId: string; line: string } =>
          !!action && typeof action === "object" && action.type === "appendOutput"
      )
      .map((action) => action.line);
    expect(lines.some((line) => line.includes("findy") && line.includes("기본 모델"))).toBe(true);
  });

  it("rolls the dropdown back when the durable write is rejected", async () => {
    const dispatch = vi.fn();
    const client = {
      call: vi.fn(async () => {
        throw new Error("profile 'findy' model write was rejected");
      }),
    } as unknown as GatewayClient;

    await applySessionSettingMutation({
      agents: [{ agentId: "agent-1", sessionCreated: true, model: "openai/gpt-5" }],
      dispatch,
      client,
      agentId: "agent-1",
      sessionKey: "agent:agent-1:main",
      field: "model",
      value: "anthropic/claude-opus-4-5",
    });

    // Leaving the optimistic value on screen would claim a default that was
    // never saved — the next session would silently disagree with the UI.
    expect(dispatch).toHaveBeenCalledWith({
      type: "updateAgent",
      agentId: "agent-1",
      patch: { model: "openai/gpt-5", sessionSettingsSynced: true },
    });
    const failure = dispatch.mock.calls
      .map((entry) => entry[0])
      .find(
        (action): action is { type: "appendOutput"; agentId: string; line: string } =>
          !!action &&
          typeof action === "object" &&
          action.type === "appendOutput" &&
          String(action.line).startsWith("Model update failed")
      );
    expect(failure?.line).toContain("rejected");
  });
});

describe("office desk model selection", () => {
  it("persists the pick through the gateway instead of local state only", async () => {
    const dispatch = vi.fn();
    const call = vi.fn(async () => ({
      ok: true,
      key: "agent:clody:main",
      resolved: {
        model: "claude-opus-4-5",
        modelProvider: "anthropic",
        scope: "profile",
        profile: "clody",
      },
    }));
    const client = { call } as unknown as GatewayClient;

    await applyOfficeModelSelection({
      agents: [{ agentId: "clody", sessionCreated: true, model: "claude-cli/claude-sonnet-4-6" }],
      dispatch,
      client,
      agentId: "clody",
      sessionKey: "agent:clody:main",
      value: "anthropic/claude-opus-4-5",
      connected: true,
    });

    expect(call).toHaveBeenCalledWith("sessions.patch", {
      key: "agent:clody:main",
      model: "anthropic/claude-opus-4-5",
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "updateAgent",
      agentId: "clody",
      patch: {
        model: "anthropic/claude-opus-4-5",
        sessionSettingsSynced: true,
        sessionCreated: true,
      },
    });
  });

  it("keeps the demo floor local when there is no gateway to persist to", async () => {
    const dispatch = vi.fn();
    const call = vi.fn();
    const client = { call } as unknown as GatewayClient;

    await applyOfficeModelSelection({
      agents: [{ agentId: "main", sessionCreated: false, model: "demo/main" }],
      dispatch,
      client,
      agentId: "main",
      sessionKey: "agent:main:main",
      value: "demo/other",
      connected: false,
    });

    expect(call).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({
      type: "updateAgent",
      agentId: "main",
      patch: { model: "demo/other" },
    });
  });
});
