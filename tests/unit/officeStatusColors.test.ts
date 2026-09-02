import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  OFFICE_STATUS_DOT_CLASS,
  OFFICE_STATUS_HEX,
  OFFICE_STATUS_PILL_CLASS,
  resolveOfficeAgentDotClass,
  resolveOfficeAgentHex,
  resolveOfficeAgentLabel,
  resolveOfficeAgentTone,
} from "@/lib/office/statusColors";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "..", "..");

describe("office status colour contract", () => {
  it("paints work green and rest neutral, never amber", () => {
    expect(resolveOfficeAgentHex({ isWorking: true })).toBe("#22c55e");
    // An idle agent is available, not a problem; amber here is what made a
    // whole office of resting agents look like it needed attention.
    expect(resolveOfficeAgentHex({ isWorking: false })).toBe(
      OFFICE_STATUS_HEX.idle,
    );
    expect(resolveOfficeAgentHex({ isWorking: false })).not.toBe(
      OFFICE_STATUS_HEX.attention,
    );
  });

  it("reserves amber for a human decision and red for failure", () => {
    expect(OFFICE_STATUS_HEX.attention).toBe("#f59e0b");
    expect(OFFICE_STATUS_HEX.error).toBe("#ef4444");
  });

  it("keeps done distinguishable from working", () => {
    expect(OFFICE_STATUS_HEX.done).not.toBe(OFFICE_STATUS_HEX.working);
    expect(OFFICE_STATUS_DOT_CLASS.done).not.toBe(OFFICE_STATUS_DOT_CLASS.working);
  });

  it("gives every tone its own colour on every surface", () => {
    for (const map of [
      OFFICE_STATUS_HEX,
      OFFICE_STATUS_DOT_CLASS,
      OFFICE_STATUS_PILL_CLASS,
    ]) {
      const values = Object.values(map);
      expect(new Set(values).size).toBe(values.length);
    }
  });

  it("treats a failure as an error even mid-run", () => {
    expect(resolveOfficeAgentTone({ isError: true, isWorking: true })).toBe("error");
  });

  it("labels each tone the way it is coloured", () => {
    expect(resolveOfficeAgentLabel({ isWorking: true })).toBe("working");
    expect(resolveOfficeAgentLabel({ isWorking: false })).toBe("idle");
    expect(resolveOfficeAgentLabel({ isError: true })).toBe("error");
  });

  it("returns the same tone through every accessor", () => {
    const working = { isWorking: true };
    expect(resolveOfficeAgentDotClass(working)).toBe(OFFICE_STATUS_DOT_CLASS.working);
    expect(resolveOfficeAgentHex(working)).toBe(OFFICE_STATUS_HEX.working);
  });
});

describe("office surfaces follow the contract", () => {
  const read = (relativePath: string) =>
    readFileSync(resolve(REPO_ROOT, relativePath), "utf8");

  it("gives the 3D status dot no amber idle of its own", () => {
    const source = read("src/features/retro-office/objects/agents.tsx");
    // The scene must not hardcode a palette that the rest of the office
    // cannot see; it reads the shared contract like everything else.
    expect(source).toContain("resolveOfficeAgentHex");
    expect(source).not.toContain('"#f59e0b"');
  });

  it("gives the roster and hover dots no yellow idle of their own", () => {
    const source = read("src/features/retro-office/RetroOffice3D.tsx");
    expect(source).not.toContain("bg-yellow-400");
    expect(source).toContain("resolveOfficeAgentDotClass");
  });

  it("colours the task board Working column as work, not as a warning", () => {
    const source = read("src/features/office/tasks/TaskBoardView.tsx");
    const working = source.slice(
      source.indexOf("  working: {"),
      source.indexOf("  needs_attention: {"),
    );
    expect(working).not.toContain("amber");
    expect(working).toContain("green");
  });

  it("keeps the task board Done column out of the working green", () => {
    const source = read("src/features/office/tasks/TaskBoardView.tsx");
    const done = source.slice(source.indexOf("  done: {"));
    expect(done).not.toContain("green");
    expect(done).toContain("cyan");
  });

  it("shows the working count in the working colour", () => {
    const source = read("src/features/office/tasks/TaskBoardView.tsx");
    expect(source).not.toContain('text-amber-200/70">{workingCount} working');
  });
});
