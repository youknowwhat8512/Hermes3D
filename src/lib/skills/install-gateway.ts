import { buildAgentMainSessionKey, type GatewayClient } from "@/lib/gateway/GatewayClient";
import {
  removeGatewayAgentFromConfigOnly,
  updateGatewayAgentOverrides,
} from "@/lib/gateway/agentConfig";
import { getPackagedSkillById } from "@/lib/skills/catalog";
import { readPackagedSkillFiles } from "@/lib/skills/packaged";
import {
  resolveWorkspaceFromAgentFiles,
  type PackagedSkillInstallRequest,
  type PackagedSkillInstallResult,
} from "@/lib/skills/types";

const normalizeRequired = (value: unknown, field: string): string => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    throw new Error(`${field} 값이 필요합니다.`);
  }
  return trimmed;
};

const normalizeOptional = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const getPathLeaf = (value: string): string => {
  const normalized = value.replace(/[\\/]+$/, "");
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? "";
};

const isRootWorkspace = (workspaceDir: string) => {
  const leaf = getPathLeaf(workspaceDir).toLowerCase();
  return leaf === "workspace";
};

const validateWorkspaceInstallTarget = (params: {
  workspaceDir: string;
  agentId?: string;
  agentName?: string;
}) => {
  if (isRootWorkspace(params.workspaceDir)) {
    const targetLabel =
      normalizeOptional(params.agentName) ||
      normalizeOptional(params.agentId) ||
      "선택한 에이전트";
    throw new Error(
      `${targetLabel}에 대해 보고된 워크스페이스가 게이트웨이 루트 워크스페이스(${params.workspaceDir})로 확인되어 패키지 스킬을 설치할 수 없습니다. 에이전트를 다시 선택하고 마켓플레이스를 새로고침한 뒤 설치해 주세요.`
    );
  }
};

const escapeForJsonString = (value: string) => JSON.stringify(value);

const buildInstallerMessage = (params: {
  skillKey: string;
  files: Array<{ relativePath: string; content: string }>;
}) => {
  const fileEntries = params.files
    .map(
      (file) =>
        `- path: ${escapeForJsonString(`skills/${params.skillKey}/${file.relativePath}`)}\n  content: ${escapeForJsonString(file.content)}`
    )
    .join("\n");

  return [
    "Create these exact skill files inside the current workspace.",
    "You must use the file tools and write the files exactly as provided.",
    "Do not modify filenames, frontmatter, spacing, or content.",
    "Create parent directories if they do not exist.",
    "After writing the files, verify they exist and then reply only with: INSTALLED",
    "",
    "Files:",
    fileEntries,
  ].join("\n");
};

const resolveRunId = (payload: unknown): string => {
  if (!payload || typeof payload !== "object") {
    throw new Error("게이트웨이가 잘못된 chat.send 응답을 반환했습니다.");
  }
  const record = payload as Record<string, unknown>;
  const runId = typeof record.runId === "string" ? record.runId.trim() : "";
  if (!runId) {
    throw new Error("게이트웨이가 잘못된 chat.send 응답을 반환했습니다(runId 없음).");
  }
  return runId;
};

const resolveMainKey = async (client: GatewayClient): Promise<string> => {
  const result = (await client.call("agents.list", {})) as { mainKey?: unknown };
  return typeof result?.mainKey === "string" && result.mainKey.trim() ? result.mainKey.trim() : "main";
};

export const installPackagedSkillViaGatewayAgent = async (params: {
  client: GatewayClient;
  request: PackagedSkillInstallRequest;
}): Promise<PackagedSkillInstallResult> => {
  const packageId = normalizeRequired(params.request.packageId, "packageId");
  const packagedSkill = getPackagedSkillById(packageId);
  if (!packagedSkill) {
    throw new Error(`알 수 없는 패키지 스킬입니다: ${packageId}`);
  }
  if (params.request.source !== "hermes-workspace") {
    throw new Error("게이트웨이 기본 패키지 설치는 현재 워크스페이스 스킬만 지원합니다.");
  }

  let workspaceDir = normalizeRequired(params.request.workspaceDir, "workspaceDir");
  if (isRootWorkspace(workspaceDir) && normalizeOptional(params.request.agentId)) {
    const recoveredWorkspace = await resolveWorkspaceFromAgentFiles(
      params.client,
      normalizeOptional(params.request.agentId)
    );
    if (recoveredWorkspace) {
      workspaceDir = recoveredWorkspace;
    }
  }
  validateWorkspaceInstallTarget({
    workspaceDir,
    agentId: params.request.agentId,
    agentName: params.request.agentName,
  });
  const files = readPackagedSkillFiles(packagedSkill.packageId);
  const installerName = `Skill Installer ${Date.now()}`;

  let installerAgentId: string | null = null;
  try {
    const created = (await params.client.call("agents.create", {
      name: installerName,
      workspace: workspaceDir,
    })) as { agentId?: unknown };
    installerAgentId =
      typeof created?.agentId === "string" ? created.agentId.trim() : "";
    if (!installerAgentId) {
      throw new Error("게이트웨이가 잘못된 agents.create 응답을 반환했습니다(agentId 없음).");
    }

    await updateGatewayAgentOverrides({
      client: params.client,
      agentId: installerAgentId,
      overrides: {
        tools: {
          alsoAllow: ["group:runtime", "group:fs"],
          deny: ["group:web"],
        },
      },
    });

    const mainKey = await resolveMainKey(params.client);
    const sessionKey = buildAgentMainSessionKey(installerAgentId, mainKey);
    const sendResult = await params.client.call("chat.send", {
      sessionKey,
      message: buildInstallerMessage({ skillKey: packagedSkill.skillKey, files }),
      deliver: false,
      idempotencyKey: `skill-install:${packagedSkill.skillKey}:${Date.now()}`,
    });
    const runId = resolveRunId(sendResult);
    await params.client.call("agent.wait", { runId, timeoutMs: 60_000 });

    return {
      installed: true,
      installedPath: `${workspaceDir.replace(/\/+$/, "")}/skills/${packagedSkill.skillKey}`,
      source: "hermes-workspace",
      skillKey: packagedSkill.skillKey,
    };
  } finally {
    if (installerAgentId) {
      try {
        await removeGatewayAgentFromConfigOnly({
          client: params.client,
          agentId: installerAgentId,
        });
      } catch {
        // Best-effort cleanup for temporary installer agents.
      }
    }
  }
};
