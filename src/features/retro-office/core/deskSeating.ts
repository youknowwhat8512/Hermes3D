import { isRemoteOfficeAgentId } from "@/features/retro-office/core/district";

// Desk ownership used to come exclusively from explicit workspace assignments, so a studio that
// never pinned anyone (the live default is an empty map) left every agent deskless — a working
// agent had no desk position to walk to and stayed roaming. This module resolves the seating chart
// once: explicit pins win, everyone else gets a deterministic leftover desk.

export type DeskSeatingAgent = {
  id: string;
  status?: "working" | "idle" | "error";
};

export type ResolveDeskIndexByAgentIdParams = {
  /** Scene agents eligible for a local desk, in whatever order the scene holds them. */
  agents: readonly DeskSeatingAgent[];
  /** Desk `_uid`s in desk-index order (index N is `deskLocations[N]`). */
  deskUids: readonly string[];
  /** Persisted `deskUid -> agentId` pins from studio settings. */
  assignmentByDeskUid?: Record<string, string>;
};

const isSeatableAgentId = (agentId: string | undefined | null): agentId is string =>
  typeof agentId === "string" &&
  agentId.length > 0 &&
  // Remote agents live in the projected remote zone and have their own furniture; handing one a
  // local desk index would teleport it across the district.
  !isRemoteOfficeAgentId(agentId);

/**
 * Resolve which desk index each agent owns.
 *
 * - Explicit pins are honoured first, in desk order, and only for agents actually in the office.
 * - A duplicate pin (same agent on two desks, or a desk already taken) keeps the first desk.
 * - Everyone left over is seated at the remaining desks, with working agents first and agent ids
 *   as the stable tiebreaker against desks sorted by index. The chart therefore does not shuffle
 *   when the agent array reorders, while scarce desks still go to agents doing real work.
 * - Agents beyond the desk capacity stay deskless rather than sharing a seat.
 */
export const resolveDeskIndexByAgentId = ({
  agents,
  deskUids,
  assignmentByDeskUid = {},
}: ResolveDeskIndexByAgentIdParams): Record<string, number> => {
  const seatableById = new Map<string, DeskSeatingAgent>();
  for (const agent of agents) {
    const agentId = agent?.id;
    if (!isSeatableAgentId(agentId)) continue;
    const current = seatableById.get(agentId);
    if (!current || (agent.status === "working" && current.status !== "working")) {
      seatableById.set(agentId, { id: agentId, status: agent.status });
    }
  }
  const seatableIds = new Set(seatableById.keys());

  const deskIndexByAgentId: Record<string, number> = {};
  const takenDeskIndexes = new Set<number>();

  deskUids.forEach((deskUid, deskIndex) => {
    const agentId = assignmentByDeskUid[deskUid];
    if (!isSeatableAgentId(agentId)) return;
    if (!seatableIds.has(agentId)) return;
    if (agentId in deskIndexByAgentId) return;
    if (takenDeskIndexes.has(deskIndex)) return;
    deskIndexByAgentId[agentId] = deskIndex;
    takenDeskIndexes.add(deskIndex);
  });

  const freeDeskIndexes = deskUids
    .map((_deskUid, deskIndex) => deskIndex)
    .filter((deskIndex) => !takenDeskIndexes.has(deskIndex));
  const unseated = [...seatableById.values()]
    .filter((agent) => !(agent.id in deskIndexByAgentId))
    .sort((left, right) => {
      const workingPriority =
        Number(right.status === "working") - Number(left.status === "working");
      if (workingPriority !== 0) return workingPriority;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });

  unseated.forEach((agent, position) => {
    const deskIndex = freeDeskIndexes[position];
    if (typeof deskIndex !== "number") return;
    deskIndexByAgentId[agent.id] = deskIndex;
  });

  return deskIndexByAgentId;
};
