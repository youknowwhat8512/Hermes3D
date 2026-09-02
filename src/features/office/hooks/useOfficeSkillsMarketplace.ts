"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentState } from "@/features/agents/state/store";
import type { GatewayClient, GatewayStatus } from "@/lib/gateway/GatewayClient";
import { readGatewayAgentSkillsAllowlist } from "@/lib/gateway/agentConfig";
import { isGatewayDisconnectLikeError } from "@/lib/gateway/GatewayClient";
import { setAgentSkillEnabled } from "@/lib/skills/agentAccess";
import {
  appendPackagedSkillsToMarketplace,
  getPackagedSkillBySkillKey,
  listPackagedSkills,
} from "@/lib/skills/catalog";
import { installPackagedSkillViaGatewayAgent } from "@/lib/skills/install-gateway";
import {
  derivePackagedInstallSupport,
  resolveGatewayMethodList,
  type PackagedInstallSupport,
} from "@/lib/skills/packagedInstallSupport";
import { resolvePreferredInstallOption } from "@/lib/skills/presentation";
import { removeSkillFromGateway } from "@/lib/skills/remove";
import {
  installSkill,
  loadAgentSkillStatus,
  updateSkill,
  type SkillStatusEntry,
  type SkillStatusReport,
} from "@/lib/skills/types";

type MarketplaceMessage = {
  kind: "success" | "error";
  text: string;
};

export const useOfficeSkillsMarketplace = ({
  client,
  status,
  enabled = true,
  agents,
  preferredAgentId,
  onSkillActivityStart,
  onSkillActivityEnd,
}: {
  client: GatewayClient;
  status: GatewayStatus;
  enabled?: boolean;
  agents: AgentState[];
  preferredAgentId?: string | null;
  onSkillActivityStart?: (agentId: string) => void;
  onSkillActivityEnd?: (agentId: string) => void;
}) => {
  const requestIdRef = useRef(0);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(
    preferredAgentId ?? null,
  );
  const [skillsReport, setSkillsReport] = useState<SkillStatusReport | null>(
    null,
  );
  const [skillsAllowlist, setSkillsAllowlist] = useState<string[] | undefined>(
    undefined,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busySkillKey, setBusySkillKey] = useState<string | null>(null);
  const [message, setMessage] = useState<MarketplaceMessage | null>(null);
  const [gatewayMethods, setGatewayMethods] = useState<string[] | null>(null);
  const packagedSkillsByKey = useMemo(
    () => new Map(listPackagedSkills().map((skill) => [skill.skillKey, skill])),
    []
  );

  const packagedInstallSupport: PackagedInstallSupport = useMemo(
    () =>
      derivePackagedInstallSupport({
        report: skillsReport,
        methods: gatewayMethods,
      }),
    [gatewayMethods, skillsReport]
  );

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.agentId === selectedAgentId) ?? null,
    [agents, selectedAgentId],
  );
  const marketplaceSkills = useMemo(
    () => appendPackagedSkillsToMarketplace(skillsReport?.skills ?? []),
    [skillsReport]
  );

  useEffect(() => {
    const preferred = (preferredAgentId ?? "").trim();
    const current = (selectedAgentId ?? "").trim();
    const hasCurrent =
      current.length > 0 && agents.some((agent) => agent.agentId === current);
    if (hasCurrent) {
      return;
    }
    if (preferred && agents.some((agent) => agent.agentId === preferred)) {
      setSelectedAgentId(preferred);
      return;
    }
    setSelectedAgentId(agents[0]?.agentId ?? null);
  }, [agents, preferredAgentId, selectedAgentId]);

  const loadMarketplace = useCallback(
    async (agentId: string) => {
      const resolvedAgentId = agentId.trim();
      if (!enabled || !resolvedAgentId || status !== "connected") {
        setSkillsReport(null);
        setSkillsAllowlist(undefined);
        setGatewayMethods(null);
        setLoading(false);
        return;
      }

      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      setLoading(true);
      setError(null);
      try {
        const [report, allowlist] = await Promise.all([
          loadAgentSkillStatus(client, resolvedAgentId),
          readGatewayAgentSkillsAllowlist({
            client,
            agentId: resolvedAgentId,
          }),
        ]);
        if (requestId !== requestIdRef.current) {
          return;
        }
        setSkillsReport(report);
        setSkillsAllowlist(allowlist);
        setGatewayMethods(resolveGatewayMethodList(client.getLastHello()));
      } catch (err) {
        if (requestId !== requestIdRef.current) {
          return;
        }
        const nextMessage =
          err instanceof Error
            ? err.message
            : "스킬 마켓플레이스 정보를 불러오지 못했습니다.";
        setSkillsReport(null);
        setSkillsAllowlist(undefined);
        setGatewayMethods(null);
        setError(nextMessage);
        if (!isGatewayDisconnectLikeError(err)) {
          console.error(nextMessage);
        }
      } finally {
        if (requestId === requestIdRef.current) {
          setLoading(false);
        }
      }
    },
    [client, enabled, status],
  );

  useEffect(() => {
    if (!enabled || !selectedAgentId || status !== "connected") {
      requestIdRef.current += 1;
      setSkillsReport(null);
      setSkillsAllowlist(undefined);
      setGatewayMethods(null);
      setLoading(false);
      return;
    }
    void loadMarketplace(selectedAgentId);
  }, [enabled, loadMarketplace, selectedAgentId, status]);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    if (!selectedAgentId) {
      return;
    }
    await loadMarketplace(selectedAgentId);
  }, [enabled, loadMarketplace, selectedAgentId]);

  const runSkillMutation = useCallback(
    async (params: {
      skillKey: string;
      successMessage: string;
      run: (agentId: string, report: SkillStatusReport) => Promise<void>;
    }) => {
      const agentId = selectedAgentId?.trim() ?? "";
      const report = skillsReport;
      const normalizedSkillKey = params.skillKey.trim();
      if (!enabled) {
        setMessage({
          kind: "error",
          text: "이 런타임은 스킬 관리 기능을 제공하지 않습니다.",
        });
        return;
      }
      if (!agentId || !report) {
        setMessage({
          kind: "error",
          text: "마켓플레이스 스킬을 관리하려면 먼저 에이전트를 선택하세요.",
        });
        return;
      }

      setBusySkillKey(normalizedSkillKey);
      setError(null);
      setMessage(null);
      onSkillActivityStart?.(agentId);
      try {
        await params.run(agentId, report);
        await loadMarketplace(agentId);
        setMessage({
          kind: "success",
          text: params.successMessage,
        });
      } catch (err) {
        const nextMessage =
          err instanceof Error
            ? err.message
            : "스킬을 업데이트하지 못했습니다.";
        setError(nextMessage);
        setMessage({
          kind: "error",
          text: nextMessage,
        });
        if (!isGatewayDisconnectLikeError(err)) {
          console.error(nextMessage);
        }
      } finally {
        onSkillActivityEnd?.(agentId);
        setBusySkillKey((current) =>
          current === normalizedSkillKey ? null : current,
        );
      }
    },
    [enabled, loadMarketplace, onSkillActivityEnd, onSkillActivityStart, selectedAgentId, skillsReport],
  );

  const handleSetSkillEnabled = useCallback(
    async (skillName: string, enabled: boolean) => {
      const entry =
        skillsReport?.skills?.find(
          (skill) => skill.name.trim() === skillName.trim(),
        ) ?? null;
      await runSkillMutation({
        skillKey: entry?.skillKey ?? skillName,
        successMessage: enabled
          ? `${selectedAgent?.name ?? "선택한 에이전트"}에서 ${skillName.trim()} 스킬을 켰습니다.`
          : `${selectedAgent?.name ?? "선택한 에이전트"}에서 ${skillName.trim()} 스킬을 껐습니다.`,
        run: async (agentId, report) => {
          await setAgentSkillEnabled({
            client,
            agentId,
            skillName,
            enabled,
            visibleSkills: report.skills,
          });
        },
      });
    },
    [client, runSkillMutation, selectedAgent?.name, skillsReport],
  );

  const handleInstallSkill = useCallback(
    async (skill: SkillStatusEntry) => {
      const installOption = resolvePreferredInstallOption(skill);
      if (!installOption) {
        setMessage({
          kind: "error",
          text: `${skill.name.trim()} 스킬에는 가이드 설치가 제공되지 않습니다.`,
        });
        return;
      }
      await runSkillMutation({
        skillKey: skill.skillKey,
        successMessage: `${skill.name.trim()} 스킬의 의존성을 설치했습니다.`,
        run: async () => {
          await installSkill(client, {
            name: skill.name,
            installId: installOption.id,
            timeoutMs: 120_000,
          });
        },
      });
    },
    [client, runSkillMutation],
  );

  const handleInstallPackagedSkill = useCallback(
    async (skillKey: string) => {
      const packagedSkill = getPackagedSkillBySkillKey(skillKey);
      if (!packagedSkill) {
        setMessage({
          kind: "error",
          text: `${skillKey.trim() || "해당 항목"}에 해당하는 패키지 스킬을 찾지 못했습니다.`,
        });
        return;
      }

      if (!packagedInstallSupport.supported) {
        setMessage({
          kind: "error",
          text:
            packagedInstallSupport.reason ??
            "이 게이트웨이는 패키지 스킬 설치를 지원하지 않습니다.",
        });
        return;
      }

      await runSkillMutation({
        skillKey: packagedSkill.skillKey,
        successMessage: `${packagedSkill.name.trim()} 스킬을 선택한 워크스페이스에 설치했습니다. HERMES3D 탭에서 에이전트용으로 켜 주세요.`,
        run: async (_agentId, report) => {
          await installPackagedSkillViaGatewayAgent({
            client,
            request: {
              packageId: packagedSkill.packageId,
              source: packagedSkill.installSource,
              workspaceDir: report.workspaceDir,
              managedSkillsDir: report.managedSkillsDir,
              agentId: selectedAgent?.agentId ?? undefined,
              agentName: selectedAgent?.name ?? undefined,
            },
          });
        },
      });
    },
    [client, packagedInstallSupport, runSkillMutation, selectedAgent]
  );

  const handleInstallPackagedSkillAndEnable = useCallback(
    async (params: {
      skillKey: string;
      agentId?: string | null;
      onProgress?: (progress: { percent: number; message: string }) => void;
    }) => {
      const packagedSkill = getPackagedSkillBySkillKey(params.skillKey);
      if (!packagedSkill) {
        setMessage({
          kind: "error",
          text: `${params.skillKey.trim() || "해당 항목"}에 해당하는 패키지 스킬을 찾지 못했습니다.`,
        });
        return;
      }

      const targetAgentId = params.agentId?.trim() || selectedAgentId?.trim() || "";
      if (!targetAgentId) {
        setMessage({
          kind: "error",
          text: "마켓플레이스 스킬을 설치하려면 먼저 에이전트를 선택하세요.",
        });
        return;
      }

      setSelectedAgentId(targetAgentId);
      setBusySkillKey(packagedSkill.skillKey);
      setError(null);
      setMessage(null);
      onSkillActivityStart?.(targetAgentId);
      try {
        params.onProgress?.({
          percent: 12,
          message: "워크스페이스 스킬 설치를 준비하는 중입니다.",
        });
        const initialReport = await loadAgentSkillStatus(client, targetAgentId);
        const support = derivePackagedInstallSupport({
          report: initialReport,
          methods: resolveGatewayMethodList(client.getLastHello()),
        });
        if (!support.supported) {
          throw new Error(
            support.reason ?? "이 게이트웨이는 패키지 스킬 설치를 지원하지 않습니다."
          );
        }
        params.onProgress?.({
          percent: 38,
          message: `${packagedSkill.name.trim()} 스킬을 워크스페이스에 설치하는 중입니다.`,
        });
        await installPackagedSkillViaGatewayAgent({
          client,
          request: {
            packageId: packagedSkill.packageId,
            source: packagedSkill.installSource,
            workspaceDir: initialReport.workspaceDir,
            managedSkillsDir: initialReport.managedSkillsDir,
            agentId: targetAgentId,
            agentName:
              agents.find((agent) => agent.agentId === targetAgentId)?.name ?? undefined,
          },
        });
        params.onProgress?.({
          percent: 62,
          message: `${packagedSkill.name.trim()} 스킬을 게이트웨이에서 켜는 중입니다.`,
        });
        await updateSkill(client, { skillKey: packagedSkill.skillKey, enabled: true });
        params.onProgress?.({
          percent: 78,
          message: `${packagedSkill.name.trim()} 스킬을 메인 에이전트에서 켜는 중입니다.`,
        });
        const refreshedReport = await loadAgentSkillStatus(client, targetAgentId);
        await setAgentSkillEnabled({
          client,
          agentId: targetAgentId,
          skillName: packagedSkill.name,
          enabled: true,
          visibleSkills: refreshedReport.skills,
        });
        params.onProgress?.({
          percent: 92,
          message: "Hermes3D에서 스킬 상태를 새로고침하는 중입니다.",
        });
        await loadMarketplace(targetAgentId);
        params.onProgress?.({
          percent: 100,
          message: `${packagedSkill.name.trim()} 스킬 설치와 활성화를 마쳤습니다.`,
        });
        const agentName =
          agents.find((agent) => agent.agentId === targetAgentId)?.name ?? "메인 에이전트";
        setMessage({
          kind: "success",
          text: `${agentName}에서 ${packagedSkill.name.trim()} 스킬을 설치하고 켰습니다.`,
        });
      } catch (err) {
        const nextMessage =
          err instanceof Error
            ? err.message
            : "스킬 설치와 활성화에 실패했습니다.";
        setError(nextMessage);
        setMessage({
          kind: "error",
          text: nextMessage,
        });
        if (!isGatewayDisconnectLikeError(err)) {
          console.error(nextMessage);
        }
        throw err instanceof Error ? err : new Error(nextMessage);
      } finally {
        onSkillActivityEnd?.(targetAgentId);
        setBusySkillKey((current) =>
          current === packagedSkill.skillKey ? null : current,
        );
      }
    },
    [
      agents,
      client,
      loadMarketplace,
      onSkillActivityEnd,
      onSkillActivityStart,
      selectedAgentId,
    ],
  );

  const handleSetSkillGlobalEnabled = useCallback(
    async (skillKey: string, enabled: boolean) => {
      await runSkillMutation({
        skillKey,
        successMessage: enabled
          ? "이 게이트웨이에서 스킬을 켰습니다."
          : "이 게이트웨이에서 스킬을 껐습니다.",
        run: async () => {
          await updateSkill(client, { skillKey, enabled });
        },
      });
    },
    [client, runSkillMutation],
  );

  const handleRemoveSkill = useCallback(
    async (skill: SkillStatusEntry) => {
      await runSkillMutation({
        skillKey: skill.skillKey,
        successMessage: `게이트웨이 파일에서 ${skill.name.trim()} 스킬을 삭제했습니다.`,
        run: async (_agentId, report) => {
          await removeSkillFromGateway({
            client,
            skillKey: skill.skillKey,
            source: skill.source as
              | "hermes-managed"
              | "hermes-workspace",
            baseDir: skill.baseDir,
            workspaceDir: report.workspaceDir,
            managedSkillsDir: report.managedSkillsDir,
          });
        },
      });
    },
    [client, runSkillMutation],
  );

  return {
    agents,
    selectedAgent,
    selectedAgentId,
    setSelectedAgentId,
    skillsReport,
    marketplaceSkills,
    packagedSkillsByKey,
    skillsAllowlist,
    packagedInstallSupport,
    loading,
    error,
    busySkillKey,
    message,
    refresh,
    handleSetSkillEnabled,
    handleInstallSkill,
    handleInstallPackagedSkill,
    handleInstallPackagedSkillAndEnable,
    handleSetSkillGlobalEnabled,
    handleRemoveSkill,
  };
};

export type OfficeSkillsMarketplaceController = ReturnType<
  typeof useOfficeSkillsMarketplace
>;
