import type { SkillStatusReport } from "@/lib/skills/types";

/**
 * Gateway method the packaged-skill installer needs in order to spawn its
 * temporary installer agent. Adapters that do not advertise it (for example the
 * bundled hermes-agent bridge) cannot run a packaged install.
 */
export const PACKAGED_INSTALL_REQUIRED_METHOD = "agents.create";

export type PackagedInstallSupport = {
  supported: boolean;
  reason: string | null;
};

const trimNonEmpty = (value: unknown): string => {
  return typeof value === "string" ? value.trim() : "";
};

/**
 * Reads the method allowlist a gateway advertised in its hello frame.
 * Returns null when the gateway does not advertise a usable list, which callers
 * must treat as "unknown capabilities" rather than "no capabilities".
 */
export const resolveGatewayMethodList = (hello: unknown): string[] | null => {
  if (!hello || typeof hello !== "object") {
    return null;
  }
  const features = (hello as { features?: unknown }).features;
  if (!features || typeof features !== "object") {
    return null;
  }
  const methods = (features as { methods?: unknown }).methods;
  if (!Array.isArray(methods)) {
    return null;
  }
  const normalized = methods
    .map((method) => trimNonEmpty(method))
    .filter((method) => method.length > 0);
  return normalized.length > 0 ? normalized : null;
};

export const derivePackagedInstallSupport = ({
  report,
  methods,
}: {
  report: SkillStatusReport | null | undefined;
  methods: string[] | null | undefined;
}): PackagedInstallSupport => {
  if (!report) {
    return {
      supported: false,
      reason:
        "패키지 스킬을 설치하기 전에 에이전트를 선택하고 마켓플레이스 목록이 불러와질 때까지 기다려 주세요.",
    };
  }

  const missingDirs: string[] = [];
  if (!trimNonEmpty(report.workspaceDir)) {
    missingDirs.push("workspaceDir");
  }
  if (!trimNonEmpty(report.managedSkillsDir)) {
    missingDirs.push("managedSkillsDir");
  }
  if (missingDirs.length > 0) {
    return {
      supported: false,
      reason: `이 게이트웨이의 skills.status 응답에 ${missingDirs.join(
        " 와(과) ",
      )} 정보가 없어 Hermes3D가 패키지 스킬의 설치 위치를 결정할 수 없습니다. 게이트웨이 호스트에서 직접 설치해 주세요.`,
    };
  }

  if (Array.isArray(methods) && !methods.includes(PACKAGED_INSTALL_REQUIRED_METHOD)) {
    return {
      supported: false,
      reason: `이 게이트웨이는 패키지 스킬 설치에 필요한 ${PACKAGED_INSTALL_REQUIRED_METHOD} 기능을 제공하지 않습니다. 게이트웨이 호스트에서 직접 설치해 주세요.`,
    };
  }

  return { supported: true, reason: null };
};
