import { describe, expect, it } from "vitest";

import {
  PACKAGED_INSTALL_REQUIRED_METHOD,
  derivePackagedInstallSupport,
  resolveGatewayMethodList,
} from "@/lib/skills/packagedInstallSupport";
import type { SkillStatusReport } from "@/lib/skills/types";

const buildReport = (
  overrides: Partial<SkillStatusReport> = {},
): SkillStatusReport => ({
  workspaceDir: "/home/hermes/workspace-demo",
  managedSkillsDir: "/home/hermes/.hermes/skills",
  skills: [],
  ...overrides,
});

describe("packaged skill install support", () => {
  it("supports install when the report and the gateway capability are both present", () => {
    const support = derivePackagedInstallSupport({
      report: buildReport(),
      methods: ["skills.status", PACKAGED_INSTALL_REQUIRED_METHOD],
    });

    expect(support.supported).toBe(true);
    expect(support.reason).toBeNull();
  });

  it("stays supported when the gateway does not advertise a method list", () => {
    const support = derivePackagedInstallSupport({
      report: buildReport(),
      methods: null,
    });

    expect(support.supported).toBe(true);
    expect(support.reason).toBeNull();
  });

  it("blocks install when the marketplace report has not loaded yet", () => {
    const support = derivePackagedInstallSupport({ report: null, methods: null });

    expect(support.supported).toBe(false);
    expect(support.reason).toMatch(/에이전트를 선택/);
  });

  it("blocks install when skills.status omits the workspace directories", () => {
    const support = derivePackagedInstallSupport({
      report: {
        skills: [],
      } as unknown as SkillStatusReport,
      methods: ["skills.status"],
    });

    expect(support.supported).toBe(false);
    expect(support.reason).toMatch(/workspaceDir/);
    expect(support.reason).toMatch(/managedSkillsDir/);
  });

  it("blocks install when the gateway advertises methods without agents.create", () => {
    const support = derivePackagedInstallSupport({
      report: buildReport(),
      methods: ["skills.status", "agents.list"],
    });

    expect(support.supported).toBe(false);
    expect(support.reason).toContain(PACKAGED_INSTALL_REQUIRED_METHOD);
  });

  it("reads the advertised method list from a gateway hello frame", () => {
    expect(
      resolveGatewayMethodList({
        features: { methods: ["skills.status", " agents.create ", "", 7] },
      }),
    ).toEqual(["skills.status", "agents.create"]);
    expect(resolveGatewayMethodList(null)).toBeNull();
    expect(resolveGatewayMethodList({ features: {} })).toBeNull();
    expect(resolveGatewayMethodList({ features: { methods: [] } })).toBeNull();
  });
});
