import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import type { AgentState } from "@/features/agents/state/store";
import { SkillsMarketplacePanel } from "@/features/office/components/panels/SkillsMarketplacePanel";
import { useOfficeSkillsMarketplace } from "@/features/office/hooks/useOfficeSkillsMarketplace";
import type { GatewayClient } from "@/lib/gateway/GatewayClient";

/**
 * Method list captured from the running bundled hermes-agent bridge
 * (scripts/probe-skills-status.mjs). It intentionally has no agents.create,
 * and its skills.status payload is `{ skills: [] }` with no workspaceDir or
 * managedSkillsDir — the exact shape that used to blow up with a raw
 * "Cannot read properties of undefined (reading 'trim')" error.
 */
const HERMES_AGENT_METHODS = [
  "agents.list",
  "agents.files.get",
  "agents.files.set",
  "sessions.list",
  "sessions.preview",
  "sessions.patch",
  "sessions.reset",
  "chat.send",
  "chat.abort",
  "chat.history",
  "agent.wait",
  "status",
  "config.get",
  "config.set",
  "config.patch",
  "exec.approvals.get",
  "exec.approvals.set",
  "exec.approval.resolve",
  "wake",
  "skills.status",
  "models.list",
  "tasks.list",
  "tasks.update",
  "cron.list",
];

const createAgent = (): AgentState =>
  ({
    agentId: "main",
    name: "Main",
    sessionKey: "agent:main:main",
    status: "idle",
  }) as unknown as AgentState;

const createBridgeClient = () =>
  ({
    call: vi.fn(async (method: string) => {
      if (method === "skills.status") {
        // Bridge returns skills only — no workspaceDir / managedSkillsDir.
        return { skills: [] };
      }
      if (method === "config.get") {
        return {
          exists: true,
          hash: "hash-1",
          config: { agents: { list: [{ id: "main" }] } },
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    }),
    getLastHello: () => ({
      type: "hello-ok",
      protocol: 3,
      adapterType: "hermes-agent",
      features: { methods: HERMES_AGENT_METHODS, events: ["chat"] },
    }),
  }) as unknown as GatewayClient;

function Harness({ client }: { client: GatewayClient }) {
  const marketplace = useOfficeSkillsMarketplace({
    client,
    status: "connected",
    agents: [createAgent()],
    preferredAgentId: "main",
  });
  return createElement(SkillsMarketplacePanel, {
    marketplace,
    onSelectAgent: () => {},
    onOpenAgentSettings: () => {},
  });
}

describe("skills marketplace on a gateway without packaged-install support", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders packaged skills without throwing on undefined workspace directories", async () => {
    const client = createBridgeClient();

    render(createElement(Harness, { client }));

    // The synthetic packaged entries must still render.
    await waitFor(() => {
      expect(screen.getAllByText("task-manager").length).toBeGreaterThan(0);
    });
  });

  it("disables packaged installs and explains why instead of surfacing a raw trim error", async () => {
    const client = createBridgeClient();

    render(createElement(Harness, { client }));

    await waitFor(() => {
      expect(screen.getAllByText("스킬 설치").length).toBeGreaterThan(0);
    });

    for (const button of screen.getAllByRole("button", { name: /스킬 설치/ })) {
      expect(button).toBeDisabled();
    }

    const notices = screen.getAllByText(
      /workspaceDir 와\(과\) managedSkillsDir 정보가 없어/,
    );
    expect(notices.length).toBeGreaterThan(0);
    expect(screen.queryByText(/reading 'trim'/i)).toBeNull();
  });

  it("does not claim an uninstalled packaged skill is enabled for the agent", async () => {
    const client = createBridgeClient();

    render(createElement(Harness, { client }));

    await waitFor(() => {
      expect(screen.getAllByText("task-manager").length).toBeGreaterThan(0);
    });

    expect(
      screen.getAllByText(/아직 게이트웨이에 설치되지 않아 에이전트에서 켤 수 없습니다/)
        .length
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/선택한 에이전트에서 켜져 있습니다/)).toBeNull();
  });
});
