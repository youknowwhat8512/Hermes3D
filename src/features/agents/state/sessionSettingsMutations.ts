import {
  isWebchatSessionMutationBlockedError,
  syncGatewaySessionSettings,
  type GatewayClient,
  type GatewaySessionsPatchResult,
} from "@/lib/gateway/GatewayClient";

type SessionSettingField = "model" | "thinkingLevel";

type AgentSessionState = {
  agentId: string;
  sessionCreated: boolean;
  model?: string | null;
  thinkingLevel?: string | null;
};

type SessionSettingsDispatchAction =
  | {
      type: "updateAgent";
      agentId: string;
      patch: {
        model?: string | null;
        thinkingLevel?: string | null;
        sessionSettingsSynced?: boolean;
        sessionCreated?: boolean;
      };
    }
  | {
      type: "appendOutput";
      agentId: string;
      line: string;
    };

type SessionSettingsDispatch = (action: SessionSettingsDispatchAction) => void;

export type ApplySessionSettingMutationParams = {
  agents: AgentSessionState[];
  dispatch: SessionSettingsDispatch;
  client: GatewayClient;
  agentId: string;
  sessionKey: string;
  field: SessionSettingField;
  value: string | null;
};

const buildFallbackError = (field: SessionSettingField) =>
  field === "model" ? "Failed to set model." : "Failed to set thinking level.";

const buildErrorPrefix = (field: SessionSettingField) =>
  field === "model" ? "Model update failed" : "Thinking update failed";

const buildWebchatBlockedMessage = (field: SessionSettingField) =>
  field === "model"
    ? "Model update not applied: this gateway blocks sessions.patch for WebChat clients; message sending still works."
    : "Thinking level update not applied: this gateway blocks sessions.patch for WebChat clients; message sending still works.";

/**
 * Confirmation for a model pick that persisted to a profile's default.
 *
 * A profile-scoped switch outlives this conversation — new sessions and other
 * clients come up on it — so it is worth one visible line rather than a silent
 * swap the operator has to infer.
 */
const buildProfileDefaultMessage = (result: GatewaySessionsPatchResult, model: string) => {
  const profile =
    typeof result.resolved?.profile === "string" ? result.resolved.profile.trim() : "";
  const target = profile ? `"${profile}"` : "이 프로필";
  const pending = result.resolved?.pendingTurn === true;
  return pending
    ? `${target}의 기본 모델을 ${model}(으)로 저장했습니다. 실행 중인 턴이 끝나면 이 세션에 적용됩니다.`
    : `${target}의 기본 모델을 ${model}(으)로 저장했습니다. 새 세션과 다른 클라이언트도 이 모델을 사용합니다.`;
};

export const applySessionSettingMutation = async ({
  agents,
  dispatch,
  client,
  agentId,
  sessionKey,
  field,
  value,
}: ApplySessionSettingMutationParams) => {
  const targetAgent = agents.find((candidate) => candidate.agentId === agentId) ?? null;
  const previousModel = targetAgent?.model ?? null;
  const previousThinkingLevel = targetAgent?.thinkingLevel ?? null;
  dispatch({
    type: "updateAgent",
    agentId,
    patch: {
      [field]: value,
      sessionSettingsSynced: false,
    },
  });
  try {
    const result = await syncGatewaySessionSettings({
      client,
      sessionKey,
      ...(field === "model" ? { model: value ?? null } : { thinkingLevel: value ?? null }),
    });
    const patch: {
      model?: string | null;
      thinkingLevel?: string | null;
      sessionSettingsSynced: boolean;
      sessionCreated: boolean;
    } = { sessionSettingsSynced: true, sessionCreated: true };
    if (field === "model") {
      const resolvedModel = resolveModelFromPatchResult(result);
      if (resolvedModel !== undefined) {
        patch.model = resolvedModel;
      }
    } else {
      const nextThinkingLevel =
        typeof result.entry?.thinkingLevel === "string" ? result.entry.thinkingLevel : undefined;
      if (nextThinkingLevel !== undefined) {
        patch.thinkingLevel = nextThinkingLevel;
      }
    }
    dispatch({
      type: "updateAgent",
      agentId,
      patch,
    });
    if (field === "model" && result.resolved?.scope === "profile") {
      dispatch({
        type: "appendOutput",
        agentId,
        line: buildProfileDefaultMessage(result, patch.model ?? value ?? ""),
      });
    }
  } catch (err) {
    if (isWebchatSessionMutationBlockedError(err)) {
      dispatch({
        type: "updateAgent",
        agentId,
        patch: {
          ...(field === "model"
            ? { model: previousModel }
            : { thinkingLevel: previousThinkingLevel }),
          sessionSettingsSynced: true,
          sessionCreated: true,
        },
      });
      dispatch({
        type: "appendOutput",
        agentId,
        line: buildWebchatBlockedMessage(field),
      });
      return;
    }
    // Roll the control back to what the gateway actually holds. Leaving the
    // optimistic value on screen claims a profile default that was never
    // written, and the next session would silently disagree with the UI.
    dispatch({
      type: "updateAgent",
      agentId,
      patch: {
        ...(field === "model"
          ? { model: previousModel }
          : { thinkingLevel: previousThinkingLevel }),
        sessionSettingsSynced: true,
      },
    });
    const msg = err instanceof Error ? err.message : buildFallbackError(field);
    dispatch({
      type: "appendOutput",
      agentId,
      line: `${buildErrorPrefix(field)}: ${msg}`,
    });
  }
};

const resolveModelFromPatchResult = (result: GatewaySessionsPatchResult): string | null | undefined => {
  const provider =
    typeof result.resolved?.modelProvider === "string" ? result.resolved.modelProvider.trim() : "";
  const model = typeof result.resolved?.model === "string" ? result.resolved.model.trim() : "";
  if (!provider || !model) return undefined;
  return `${provider}/${model}`;
};
