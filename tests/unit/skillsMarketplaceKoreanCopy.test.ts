import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import type { AgentState } from "@/features/agents/state/store";
import { SkillsMarketplacePanel } from "@/features/office/components/panels/SkillsMarketplacePanel";
import { useOfficeSkillsMarketplace } from "@/features/office/hooks/useOfficeSkillsMarketplace";
import type { GatewayClient } from "@/lib/gateway/GatewayClient";
import { buildPackagedSkillStatusEntry, listPackagedSkills } from "@/lib/skills/catalog";
import {
  buildLocalizedSkillMissingDetails,
  buildSkillMarketplaceCollections,
  resolveSkillMarketplaceMetadata,
} from "@/lib/skills/marketplace";
import { derivePackagedInstallSupport } from "@/lib/skills/packagedInstallSupport";
import type { SkillStatusEntry } from "@/lib/skills/types";

const HANGUL = /[가-힣]/;

const buildSkill = (overrides: Partial<SkillStatusEntry> = {}): SkillStatusEntry => ({
  name: "playwright-runner",
  description: "",
  source: "hermes-managed",
  bundled: false,
  filePath: "/skills/playwright-runner/SKILL.md",
  baseDir: "/skills/playwright-runner",
  skillKey: "playwright-runner",
  always: false,
  disabled: false,
  blockedByAllowlist: false,
  eligible: false,
  requirements: { bins: [], anyBins: [], env: [], config: [], os: [] },
  missing: { bins: [], anyBins: [], env: [], config: [], os: [] },
  configChecks: [],
  install: [],
  ...overrides,
});

const createAgent = (): AgentState =>
  ({
    agentId: "main",
    name: "Main",
    sessionKey: "agent:main:main",
    status: "idle",
  }) as unknown as AgentState;

const createReadyClient = () =>
  ({
    call: vi.fn(async (method: string) => {
      if (method === "skills.status") {
        return {
          workspaceDir: "/home/hermes/workspace-main",
          managedSkillsDir: "/home/hermes/.hermes/skills",
          skills: [
            buildSkill({
              name: "github",
              skillKey: "github",
              source: "hermes-bundled",
              bundled: true,
              eligible: true,
            }),
          ],
        };
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
      features: { methods: ["skills.status", "agents.create"], events: ["chat"] },
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

describe("skills marketplace Korean copy", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the panel chrome in Korean", async () => {
    render(createElement(Harness, { client: createReadyClient() }));

    await waitFor(() => {
      expect(screen.getAllByText("스킬 마켓플레이스").length).toBeGreaterThan(0);
    });

    expect(
      screen.getByText("게이트웨이 스킬을 큐레이션된 플러그인 스토어처럼 둘러보세요."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /새로고침/ })).toBeTruthy();
    expect(screen.getByLabelText("마켓플레이스 스킬 검색")).toBeTruthy();
    expect(screen.getByText("에이전트 문맥")).toBeTruthy();
    expect(screen.getByRole("button", { name: /채팅 보기/ })).toBeTruthy();
    expect(screen.getByText(/접근 모드: 모든 스킬 허용/)).toBeTruthy();
  });

  it("labels every marketplace filter in Korean except the Hermes3D identifier", async () => {
    render(createElement(Harness, { client: createReadyClient() }));

    await waitFor(() => {
      expect(screen.getAllByText("스킬 마켓플레이스").length).toBeGreaterThan(0);
    });

    for (const label of [
      "전체",
      "추천",
      "설치됨",
      "설정 필요",
      "기본 제공",
      "워크스페이스",
      "커뮤니티",
      "기타",
    ]) {
      expect(
        screen.getAllByRole("button", { name: new RegExp(`^${label} \\(`) }).length,
      ).toBeGreaterThan(0);
    }
    expect(
      screen.getAllByRole("button", { name: /^Hermes3D \(/ }).length,
    ).toBeGreaterThan(0);
  });

  it("keeps packaged skill identifiers and creator attribution untranslated", () => {
    const packagedSkills = listPackagedSkills();
    expect(packagedSkills.map((skill) => skill.skillKey).sort()).toEqual([
      "soundhermes",
      "task-manager",
      "todo-board",
    ]);

    for (const packagedSkill of packagedSkills) {
      expect(HANGUL.test(packagedSkill.skillKey)).toBe(false);
      expect(HANGUL.test(packagedSkill.name)).toBe(false);
      expect(HANGUL.test(packagedSkill.creatorName ?? "")).toBe(false);
      expect(HANGUL.test(packagedSkill.creatorUrl ?? "")).toBe(false);
      expect(HANGUL.test(packagedSkill.description)).toBe(true);

      const metadata = resolveSkillMarketplaceMetadata(
        buildPackagedSkillStatusEntry(packagedSkill),
      );
      expect(HANGUL.test(metadata.category)).toBe(true);
      expect(HANGUL.test(metadata.tagline)).toBe(true);
      expect(metadata.poweredByName).toBe(packagedSkill.creatorName);
    }
  });

  it("localizes fallback metadata, setup notes, and collection labels", () => {
    const metadata = resolveSkillMarketplaceMetadata(
      buildSkill({
        install: [{ id: "brew", kind: "brew", label: "brew", bins: ["playwright"] }],
      }),
    );
    expect(metadata.category).toBe("설치됨");
    expect(metadata.trustLabel).toBe("관리됨");
    expect(metadata.capabilities.some((line) => HANGUL.test(line))).toBe(true);

    const details = buildLocalizedSkillMissingDetails(
      buildSkill({
        missing: {
          bins: ["playwright"],
          anyBins: ["node"],
          env: ["GITHUB_TOKEN"],
          config: ["github.token"],
          os: ["darwin"],
        },
      }),
    );
    expect(details).toEqual([
      "설치가 필요한 도구: playwright",
      "다음 중 하나를 설치하세요: node",
      "게이트웨이 환경 변수에 설정이 필요한 값: GITHUB_TOKEN",
      "hermes.json에 설정이 필요한 값: github.token",
      "지원 운영체제: macOS",
    ]);

    const collections = buildSkillMarketplaceCollections([
      buildSkill({ source: "hermes-bundled", bundled: true, eligible: true }),
      buildPackagedSkillStatusEntry(listPackagedSkills()[0]),
    ]);
    const labels = collections.map((collection) => collection.label);
    expect(labels).toContain("추천");
    expect(labels).toContain("Hermes3D");
    expect(labels).toContain("설치됨");
    expect(labels).toContain("기본 제공 스킬");
    for (const label of labels) {
      expect(label === "Hermes3D" || HANGUL.test(label)).toBe(true);
    }
  });

  it("returns Korean packaged-install guidance while preserving technical field names", () => {
    const missingDirs = derivePackagedInstallSupport({
      report: { skills: [] } as never,
      methods: ["skills.status"],
    });
    expect(missingDirs.supported).toBe(false);
    expect(missingDirs.reason).toContain("workspaceDir");
    expect(missingDirs.reason).toContain("managedSkillsDir");
    expect(HANGUL.test(missingDirs.reason ?? "")).toBe(true);

    const missingMethod = derivePackagedInstallSupport({
      report: {
        workspaceDir: "/home/hermes/workspace-main",
        managedSkillsDir: "/home/hermes/.hermes/skills",
        skills: [],
      },
      methods: ["skills.status"],
    });
    expect(missingMethod.supported).toBe(false);
    expect(missingMethod.reason).toContain("agents.create");
    expect(HANGUL.test(missingMethod.reason ?? "")).toBe(true);
  });
});
