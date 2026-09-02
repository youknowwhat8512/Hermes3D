import type {
  RemovableSkillSource,
  SkillStatusEntry,
} from "@/lib/skills/types";

export type PackagedSkillId = "soundhermes" | "task-manager" | "todo-board";

export type PackagedSkillDefinition = {
  packageId: PackagedSkillId;
  skillKey: string;
  name: string;
  description: string;
  installSource: RemovableSkillSource;
  creatorName?: string;
  creatorUrl?: string;
};

const EMPTY_REQUIREMENTS = {
  bins: [],
  anyBins: [],
  env: [],
  config: [],
  os: [],
};

const PACKAGED_SKILLS: PackagedSkillDefinition[] = [
  {
    packageId: "todo-board",
    skillKey: "todo-board",
    name: "todo",
    description: "차단된 작업까지 포함한 공용 워크스페이스 TODO 목록을 관리합니다.",
    installSource: "hermes-workspace",
    creatorName: "iamlukethedev",
    creatorUrl: "http://x.com/iamlukethedev/",
  },
  {
    packageId: "task-manager",
    skillKey: "task-manager",
    name: "task-manager",
    description:
      "실행이 필요한 요청을 지속되는 작업으로 기록하고 공용 칸반 작업 저장소를 동기화합니다.",
    installSource: "hermes-workspace",
    creatorName: "iamlukethedev",
    creatorUrl: "https://github.com/iamlukethedev",
  },
  {
    packageId: "soundhermes",
    skillKey: "soundhermes",
    name: "soundhermes",
    description: "Spotify 재생을 제어하고 음악을 검색해 공유 가능한 링크를 돌려줍니다.",
    installSource: "hermes-workspace",
    creatorName: "iamlukethedev",
    creatorUrl: "https://github.com/iamlukethedev",
  },
];

export const listPackagedSkills = (): PackagedSkillDefinition[] => [
  ...PACKAGED_SKILLS,
];

export const getPackagedSkillById = (
  packageId: string,
): PackagedSkillDefinition | null =>
  PACKAGED_SKILLS.find((skill) => skill.packageId === packageId) ?? null;

export const getPackagedSkillBySkillKey = (
  skillKey: string,
): PackagedSkillDefinition | null => {
  const normalized = skillKey.trim();
  return PACKAGED_SKILLS.find((skill) => skill.skillKey === normalized) ?? null;
};

export const buildPackagedSkillStatusEntry = (
  skill: PackagedSkillDefinition,
): SkillStatusEntry => ({
  name: skill.name,
  description: skill.description,
  source: "hermes-extra",
  bundled: false,
  filePath: "",
  baseDir: "",
  skillKey: skill.skillKey,
  always: false,
  disabled: false,
  blockedByAllowlist: false,
  eligible: false,
  requirements: { ...EMPTY_REQUIREMENTS },
  missing: { ...EMPTY_REQUIREMENTS },
  configChecks: [],
  install: [],
});

export const appendPackagedSkillsToMarketplace = (
  skills: SkillStatusEntry[],
): SkillStatusEntry[] => {
  const presentKeys = new Set(skills.map((skill) => skill.skillKey.trim()));
  const additions = PACKAGED_SKILLS.filter(
    (skill) => !presentKeys.has(skill.skillKey),
  ).map(buildPackagedSkillStatusEntry);
  if (additions.length === 0) {
    return skills;
  }
  return [...additions, ...skills];
};
