import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { resolveDeskIndexByAgentId } from "@/features/retro-office/core/deskSeating";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "..", "..");

const deskUids = (count: number) =>
  Array.from({ length: count }, (_, index) => `desk-${index}`);

describe("desk seating assignment", () => {
  it("seats every agent even when nobody has an explicit desk", () => {
    // The live studio ships deskAssignments={}, which used to leave the whole
    // office deskless — a working agent then had nowhere to walk to.
    const result = resolveDeskIndexByAgentId({
      agents: [{ id: "beta" }, { id: "alpha" }],
      deskUids: deskUids(4),
    });

    expect(result).toEqual({ alpha: 0, beta: 1 });
  });

  it("prioritizes a working agent when desks are limited", () => {
    const result = resolveDeskIndexByAgentId({
      agents: [
        { id: "alpha", status: "idle" },
        { id: "zulu", status: "working" },
      ],
      deskUids: deskUids(1),
    });

    expect(result).toEqual({ zulu: 0 });
  });

  it("keeps an explicit desk assignment and works around it", () => {
    const result = resolveDeskIndexByAgentId({
      agents: [{ id: "alpha" }, { id: "beta" }],
      deskUids: deskUids(3),
      assignmentByDeskUid: { "desk-2": "beta" },
    });

    expect(result).toEqual({ beta: 2, alpha: 0 });
  });

  it("ignores explicit assignments for agents that are not in the office", () => {
    const result = resolveDeskIndexByAgentId({
      agents: [{ id: "alpha" }],
      deskUids: deskUids(2),
      assignmentByDeskUid: { "desk-0": "ghost" },
    });

    // A pin for someone who is not here frees the desk instead of reserving it.
    expect(result).toEqual({ alpha: 0 });
    expect(result.ghost).toBeUndefined();
  });

  it("gives one agent one desk when the same agent is pinned twice", () => {
    const result = resolveDeskIndexByAgentId({
      agents: [{ id: "alpha" }, { id: "beta" }],
      deskUids: deskUids(3),
      assignmentByDeskUid: { "desk-1": "alpha", "desk-2": "alpha" },
    });

    expect(result.alpha).toBe(1);
    expect(result.beta).toBe(0);
  });

  it("never seats two agents at the same desk", () => {
    const result = resolveDeskIndexByAgentId({
      agents: [{ id: "alpha" }, { id: "beta" }, { id: "gamma" }],
      deskUids: deskUids(3),
      assignmentByDeskUid: { "desk-1": "gamma" },
    });

    const seats = Object.values(result);
    expect(new Set(seats).size).toBe(seats.length);
    expect(seats.sort()).toEqual([0, 1, 2]);
  });

  it("leaves agents deskless once the desks run out", () => {
    const result = resolveDeskIndexByAgentId({
      agents: [{ id: "alpha" }, { id: "beta" }, { id: "gamma" }],
      deskUids: deskUids(2),
    });

    expect(Object.keys(result).sort()).toEqual(["alpha", "beta"]);
    expect(result.gamma).toBeUndefined();
  });

  it("returns no desks when the layout has none", () => {
    expect(
      resolveDeskIndexByAgentId({ agents: [{ id: "alpha" }], deskUids: [] }),
    ).toEqual({});
  });

  it("keeps the same seat when the agent list is reordered", () => {
    const params = {
      deskUids: deskUids(3),
      assignmentByDeskUid: { "desk-2": "beta" },
    };
    const forward = resolveDeskIndexByAgentId({
      ...params,
      agents: [{ id: "alpha" }, { id: "beta" }, { id: "gamma" }],
    });
    const reversed = resolveDeskIndexByAgentId({
      ...params,
      agents: [{ id: "gamma" }, { id: "beta" }, { id: "alpha" }],
    });

    expect(reversed).toEqual(forward);
  });

  it("does not auto-seat remote-office agents at local desks", () => {
    // Remote agents live in a projected zone with its own furniture; a local
    // desk index would teleport them across the district.
    const result = resolveDeskIndexByAgentId({
      agents: [{ id: "remote:alpha" }, { id: "beta" }],
      deskUids: deskUids(2),
    });

    expect(result).toEqual({ beta: 0 });
  });

  it("tolerates duplicate and blank ids without duplicating seats", () => {
    const result = resolveDeskIndexByAgentId({
      agents: [{ id: "alpha" }, { id: "alpha" }, { id: "" }],
      deskUids: deskUids(3),
    });

    expect(result).toEqual({ alpha: 0 });
  });
});

describe("scene desk behaviour contract", () => {
  const source = readFileSync(
    resolve(REPO_ROOT, "src/features/retro-office/RetroOffice3D.tsx"),
    "utf8",
  );

  it("derives scene desk ownership through the seating helper", () => {
    expect(source).toContain("resolveDeskIndexByAgentId");
  });

  it("sits a working agent down once it reaches its desk", () => {
    const deskBranch = source.slice(
      source.indexOf('} else if (effectiveStatus === "working" && deskPos) {'),
      source.indexOf('} else if (effectiveStatus === "working") {'),
    );
    expect(deskBranch).toContain('ns.interactionTarget = "desk"');
    expect(deskBranch).toContain('? "sitting"');
    expect(deskBranch).toContain(': "walking"');
  });

  it("never routes an idle agent to a desk", () => {
    // Owning a seat must not drag a resting agent back to it; only the
    // working branch reads deskPos.
    expect(source).toContain('if (agent.status === "working" && !explicitDeskHold && deskPos)');
    expect(source).not.toContain('effectiveStatus === "idle" && deskPos');
  });

  it("lets explicit room holds win over the desk", () => {
    const deskBranchIndex = source.indexOf(
      '} else if (effectiveStatus === "working" && deskPos) {',
    );
    expect(deskBranchIndex).toBeGreaterThan(0);
    // Each room branch has to be evaluated before the desk branch, otherwise a
    // seated agent would never leave for the gym, QA lab, booths, or standup.
    for (const holdBranch of [
      "if (explicitMeetingHold && meetingTarget) {",
      "} else if (explicitGymHold) {",
      "} else if (explicitQaHold) {",
      "} else if (explicitGithubHold) {",
      "} else if (explicitSmsBoothHold) {",
      "} else if (explicitPhoneBoothHold) {",
    ]) {
      const holdIndex = source.indexOf(holdBranch);
      expect(holdIndex).toBeGreaterThan(0);
      expect(holdIndex).toBeLessThan(deskBranchIndex);
    }
  });
});
