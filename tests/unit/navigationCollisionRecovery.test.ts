import { describe, expect, it } from "vitest";

import type { RenderAgent } from "@/features/retro-office/core/types";
import { applyAgentCollisionBumps } from "@/features/retro-office/systems/NavigationSystem";

const agent = (id: string, patch: Partial<RenderAgent> = {}): RenderAgent =>
  ({
    id,
    name: id,
    status: "idle",
    color: "#fff",
    item: "laptop",
    x: 100,
    y: 100,
    targetX: 1234,
    targetY: 567,
    path: [{ x: 1234, y: 567 }],
    facing: 0,
    frame: 0,
    walkSpeed: 0.3,
    phaseOffset: 0,
    state: "walking",
    ...patch,
  }) as RenderAgent;

describe("applyAgentCollisionBumps", () => {
  it("preserves a desk-bound worker's chair target across a collision", () => {
    const deskWorker = agent("worker", {
      status: "working",
      interactionTarget: "desk",
      targetX: 140,
      targetY: 295,
      path: [{ x: 140, y: 295 }],
    });
    const idleAgent = agent("idle", { x: 110 });

    const [bumpedWorker, bumpedIdle] = applyAgentCollisionBumps({
      agents: [deskWorker, idleAgent],
      now: 10_000,
    });

    expect(bumpedWorker.bumpedUntil).toBeGreaterThan(10_000);
    expect([bumpedWorker.targetX, bumpedWorker.targetY]).toEqual([140, 295]);
    expect([bumpedIdle.targetX, bumpedIdle.targetY]).not.toEqual([1234, 567]);
  });
});
