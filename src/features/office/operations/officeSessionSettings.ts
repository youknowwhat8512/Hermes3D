import {
  applySessionSettingMutation,
  type ApplySessionSettingMutationParams,
} from "@/features/agents/state/sessionSettingsMutations";

export type ApplyOfficeModelSelectionParams = {
  agents: ApplySessionSettingMutationParams["agents"];
  dispatch: ApplySessionSettingMutationParams["dispatch"];
  client: ApplySessionSettingMutationParams["client"];
  agentId: string;
  sessionKey: string;
  value: string | null;
  /** Whether the gateway link is live; the office renders a demo floor offline. */
  connected: boolean;
};

/**
 * Route an office model pick through the gateway instead of local state.
 *
 * The office desk used to answer its dropdown with a bare `updateAgent`
 * dispatch, so the pick never reached the gateway: the label changed, the
 * profile default did not, and a reconnect snapped it back. Model selection is
 * a profile-scoped write, so it has to travel the same
 * `applySessionSettingMutation` path the agents page uses — which persists the
 * default, applies it to the live session, and reverts the control when the
 * write is rejected.
 *
 * With no gateway (the offline demo floor) there is nothing to persist to, so
 * the optimistic local update stands on its own.
 */
export const applyOfficeModelSelection = async ({
  agents,
  dispatch,
  client,
  agentId,
  sessionKey,
  value,
  connected,
}: ApplyOfficeModelSelectionParams) => {
  if (!connected || !sessionKey.trim()) {
    dispatch({
      type: "updateAgent",
      agentId,
      patch: { model: value },
    });
    return;
  }
  await applySessionSettingMutation({
    agents,
    dispatch,
    client,
    agentId,
    sessionKey,
    field: "model",
    value,
  });
};
