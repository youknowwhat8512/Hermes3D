import {
  canRemoveSkill,
  deriveSkillReadinessState,
  groupSkillsBySource,
  hasInstallableMissingBinary,
  type SkillReadinessState,
} from "@/lib/skills/presentation";
import { getPackagedSkillBySkillKey } from "@/lib/skills/catalog";
import type { SkillStatusEntry } from "@/lib/skills/types";

export type SkillMarketplaceCollectionId =
  | "hermes3d"
  | "featured"
  | "installed"
  | "setup-required"
  | "built-in"
  | "workspace"
  | "extra"
  | "other";

export type SkillMarketplaceMetadata = {
  category: string;
  tagline: string;
  trustLabel: string;
  capabilities: string[];
  featured?: boolean;
  editorBadge?: string;
  rating?: number;
  installs?: number;
  poweredByName?: string;
  poweredByUrl?: string;
  hideStats?: boolean;
};

export type SkillMarketplaceEntry = {
  skill: SkillStatusEntry;
  readiness: SkillReadinessState;
  metadata: SkillMarketplaceMetadata;
  installable: boolean;
  removable: boolean;
  missingDetails: string[];
};

const SKILL_MARKETPLACE_OVERRIDES: Record<
  string,
  Partial<SkillMarketplaceMetadata>
> = {
  github: {
    category: "엔지니어링",
    tagline: "저장소 작업을 한 단계로 처리하는 팀원 워크플로로 만들어 줍니다.",
    capabilities: [
      "풀 리퀘스트 지원",
      "이슈 문맥 파악",
      "저장소 작업 수행",
    ],
    featured: true,
    editorBadge: "인기",
    rating: 4.9,
    installs: 18240,
  },
  figma: {
    category: "디자인",
    tagline: "디자인 파일, 스펙, 구현 문맥을 이어 줍니다.",
    capabilities: ["디자인 문맥 파악", "에셋 조회", "스펙 핸드오프"],
    featured: true,
    editorBadge: "에디터 추천",
    rating: 4.8,
    installs: 9640,
  },
  slack: {
    category: "커뮤니케이션",
    tagline: "에이전트를 팀 채널과 알림에 계속 연결해 둡니다.",
    capabilities: [
      "채널 소식 확인",
      "메시지 초안 작성",
      "알림 라우팅",
    ],
    featured: true,
    rating: 4.7,
    installs: 14110,
  },
  linear: {
    category: "기획",
    tagline: "이슈 추적과 실행 루프를 에이전트 워크플로 안으로 가져옵니다.",
    capabilities: ["이슈 조회", "상태 업데이트", "기획 워크플로"],
    featured: true,
    rating: 4.7,
    installs: 11980,
  },
  "todo-board": {
    category: "생산성",
    tagline:
      "차단된 작업까지 추적하는 공용 워크스페이스 TODO 보드를 에이전트에게 제공합니다.",
    capabilities: [
      "할 일 기록",
      "차단 상태 추적",
      "워크스페이스 상태 공유",
    ],
    featured: true,
    editorBadge: "Hermes3D 테스트",
    hideStats: true,
  },
  "task-manager": {
    category: "생산성",
    tagline:
      "실행이 필요한 요청을 지속되는 공용 작업으로 만들어 Hermes3D 칸반 보드를 움직입니다.",
    capabilities: [
      "작업 자동 기록",
      "작업 생애주기 추적",
      "칸반 상태 공유",
    ],
    featured: true,
    editorBadge: "칸반 핵심",
    hideStats: true,
  },
  soundhermes: {
    category: "오디오",
    tagline:
      "에이전트가 Spotify를 검색하고 재생을 제어하며 현재 채널에 음악 링크를 돌려줍니다.",
    capabilities: ["Spotify 검색", "재생 제어", "같은 채널로 링크 공유"],
    featured: true,
    editorBadge: "오피스 데모",
    hideStats: true,
  },
};

const MARKETPLACE_COLLECTION_LABELS: Record<
  SkillMarketplaceCollectionId,
  string
> = {
  hermes3d: "Hermes3D",
  featured: "추천",
  installed: "설치됨",
  "setup-required": "설정 필요",
  "built-in": "기본 제공 스킬",
  workspace: "워크스페이스 스킬",
  extra: "추가 스킬",
  other: "기타 스킬",
};

const OS_LABELS: Record<string, string> = {
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows",
  windows: "Windows",
};

const normalizeList = (values: string[] | undefined): string[] => {
  if (!Array.isArray(values)) {
    return [];
  }
  return values
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0);
};

/**
 * Korean copy for the marketplace surface. The shared
 * `buildSkillMissingDetails` helper stays English because agent/system skill
 * panels outside the marketplace still render it.
 */
export const buildLocalizedSkillMissingDetails = (
  skill: SkillStatusEntry,
): string[] => {
  const details: string[] = [];

  const bins = normalizeList(skill.missing.bins);
  if (bins.length > 0) {
    details.push(`설치가 필요한 도구: ${bins.join(", ")}`);
  }

  const anyBins = normalizeList(skill.missing.anyBins);
  if (anyBins.length > 0) {
    details.push(`다음 중 하나를 설치하세요: ${anyBins.join(" | ")}`);
  }

  const env = normalizeList(skill.missing.env);
  if (env.length > 0) {
    details.push(`게이트웨이 환경 변수에 설정이 필요한 값: ${env.join(", ")}`);
  }

  const config = normalizeList(skill.missing.config);
  if (config.length > 0) {
    details.push(`hermes.json에 설정이 필요한 값: ${config.join(", ")}`);
  }

  const os = normalizeList(skill.missing.os);
  if (os.length > 0) {
    const labels = os.map(
      (value) => OS_LABELS[value.toLowerCase()] ?? value,
    );
    details.push(`지원 운영체제: ${labels.join(", ")}`);
  }

  return details;
};

const hashString = (value: string): number => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = value.charCodeAt(index) + ((hash << 5) - hash);
  }
  return Math.abs(hash);
};

const titleCaseWords = (value: string): string =>
  value
    .split(/[\s_-]+/)
    .filter((part) => part.length > 0)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");

const buildFallbackCapabilities = (skill: SkillStatusEntry): string[] => {
  const capabilities: string[] = [];
  if (skill.primaryEnv) {
    capabilities.push(`${skill.primaryEnv} 환경 변수를 사용합니다.`);
  }
  if (skill.install.length > 0) {
    capabilities.push("가이드 방식의 의존성 설치를 지원합니다.");
  }
  if (skill.always) {
    capabilities.push("정책상 항상 사용할 수 있습니다.");
  }
  if (skill.homepage) {
    capabilities.push("외부 문서가 제공됩니다.");
  }
  if (capabilities.length === 0) {
    capabilities.push("재사용 가능한 운영 워크플로입니다.");
  }
  return capabilities.slice(0, 3);
};

const buildFallbackMetadata = (
  skill: SkillStatusEntry,
): SkillMarketplaceMetadata => {
  const normalizedKey = skill.skillKey.trim().toLowerCase();
  const source = skill.source.trim();
  const seed = hashString(`${normalizedKey}:${source}`);
  const category =
    skill.bundled || source === "hermes-bundled"
      ? "기본 제공"
      : source === "hermes-managed"
        ? "설치됨"
        : source === "hermes-workspace"
          ? "워크스페이스"
          : source === "hermes-extra"
            ? "커뮤니티"
            : "자동화";
  const trustLabel =
    skill.bundled || source === "hermes-bundled"
      ? "검증됨"
      : source === "hermes-managed"
        ? "관리됨"
        : source === "hermes-workspace"
          ? "워크스페이스"
          : "커뮤니티";
  return {
    category,
    tagline:
      skill.description.trim() ||
      `${titleCaseWords(skill.name)} 기능 팩입니다.`,
    trustLabel,
    capabilities: buildFallbackCapabilities(skill),
    featured: skill.bundled || source === "hermes-managed",
    rating: 4.2 + (seed % 7) / 10,
    installs: 400 + (seed % 9500),
  };
};

export const resolveSkillMarketplaceMetadata = (
  skill: SkillStatusEntry,
): SkillMarketplaceMetadata => {
  const normalizedKey = skill.skillKey.trim().toLowerCase();
  const fallback = buildFallbackMetadata(skill);
  const override = SKILL_MARKETPLACE_OVERRIDES[normalizedKey];
  const packagedSkill = getPackagedSkillBySkillKey(skill.skillKey);
  if (!override) {
    return {
      ...fallback,
      poweredByName: packagedSkill?.creatorName,
      poweredByUrl: packagedSkill?.creatorUrl,
      hideStats: Boolean(packagedSkill),
    };
  }
  return {
    ...fallback,
    ...override,
    capabilities: override.capabilities ?? fallback.capabilities,
    poweredByName: packagedSkill?.creatorName,
    poweredByUrl: packagedSkill?.creatorUrl,
    hideStats: override.hideStats ?? Boolean(packagedSkill),
  };
};

export const buildSkillMarketplaceEntry = (
  skill: SkillStatusEntry,
): SkillMarketplaceEntry => {
  const packagedSkill = getPackagedSkillBySkillKey(skill.skillKey);
  const missingDetails = buildLocalizedSkillMissingDetails(skill);
  if (packagedSkill && !skill.baseDir.trim()) {
    missingDetails.unshift(
      "이 Hermes3D 패키지 스킬을 설치하면 게이트웨이에서 사용할 수 있습니다.",
    );
  }
  return {
    skill,
    readiness: deriveSkillReadinessState(skill),
    metadata: resolveSkillMarketplaceMetadata(skill),
    installable: hasInstallableMissingBinary(skill),
    removable: canRemoveSkill(skill),
    missingDetails,
  };
};

export const buildSkillMarketplaceCollections = (
  skills: SkillStatusEntry[],
): Array<{
  id: SkillMarketplaceCollectionId;
  label: string;
  entries: SkillMarketplaceEntry[];
}> => {
  const entries = skills.map(buildSkillMarketplaceEntry);
  const sourceGroups = groupSkillsBySource(skills);
  const collections: Array<{
    id: SkillMarketplaceCollectionId;
    label: string;
    entries: SkillMarketplaceEntry[];
  }> = [];

  const featured = entries
    .filter((entry) => entry.metadata.featured)
    .slice(0, 6);
  if (featured.length > 0) {
    collections.push({
      id: "featured",
      label: MARKETPLACE_COLLECTION_LABELS.featured,
      entries: featured,
    });
  }

  const hermes3d = entries.filter((entry) =>
    getPackagedSkillBySkillKey(entry.skill.skillKey),
  );
  if (hermes3d.length > 0) {
    collections.push({
      id: "hermes3d",
      label: MARKETPLACE_COLLECTION_LABELS.hermes3d,
      entries: hermes3d,
    });
  }

  const installed = entries.filter(
    (entry) => entry.readiness === "ready" || entry.skill.disabled,
  );
  if (installed.length > 0) {
    collections.push({
      id: "installed",
      label: MARKETPLACE_COLLECTION_LABELS.installed,
      entries: installed,
    });
  }

  const setupRequired = entries.filter(
    (entry) => entry.readiness === "needs-setup",
  );
  if (setupRequired.length > 0) {
    collections.push({
      id: "setup-required",
      label: MARKETPLACE_COLLECTION_LABELS["setup-required"],
      entries: setupRequired,
    });
  }

  for (const group of sourceGroups) {
    const groupEntries = group.skills.map(buildSkillMarketplaceEntry);
    const groupId =
      group.id === "built-in" ||
      group.id === "workspace" ||
      group.id === "extra" ||
      group.id === "other"
        ? group.id
        : "installed";
    collections.push({
      id: groupId,
      label: MARKETPLACE_COLLECTION_LABELS[groupId],
      entries: groupEntries,
    });
  }

  return collections;
};
