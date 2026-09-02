/**
 * The one place the office decides what a status colour means.
 *
 * Every surface that shows agent or task state — the 3D status dot, the roster
 * badges, the hover card, the task board columns — reads from here, because
 * the same colour meaning something different on two surfaces is exactly how
 * an operator ends up misreading their own office.
 *
 * The contract:
 *
 *   working / running   green    someone is doing work right now
 *   idle                neutral  available, nothing in flight
 *   attention / waiting amber    a human is needed (approval, blocked, queued)
 *   error               red      something failed
 *   done                cyan     finished — deliberately NOT green, so a
 *                                completed column cannot be mistaken for a
 *                                busy one at a glance
 */

export type OfficeStatusTone =
  | "working"
  | "idle"
  | "attention"
  | "error"
  | "done";

/** Hex used by the Three.js materials, which cannot take a CSS class. */
export const OFFICE_STATUS_HEX: Record<OfficeStatusTone, string> = {
  working: "#22c55e",
  idle: "#94a3b8",
  attention: "#f59e0b",
  error: "#ef4444",
  done: "#22d3ee",
};

/** Tailwind background class for a small status dot. */
export const OFFICE_STATUS_DOT_CLASS: Record<OfficeStatusTone, string> = {
  working: "bg-green-400",
  idle: "bg-slate-400",
  attention: "bg-amber-400",
  error: "bg-red-400",
  done: "bg-cyan-400",
};

/** Tailwind classes for a status pill: background, text, and ring together. */
export const OFFICE_STATUS_PILL_CLASS: Record<OfficeStatusTone, string> = {
  working: "bg-green-900/40 text-green-400 ring-1 ring-green-800/40",
  idle: "bg-slate-800/40 text-slate-300 ring-1 ring-slate-600/30",
  attention: "bg-amber-900/40 text-amber-400 ring-1 ring-amber-800/40",
  error: "bg-red-900/40 text-red-400 ring-1 ring-red-800/40",
  done: "bg-cyan-900/40 text-cyan-300 ring-1 ring-cyan-800/40",
};

/**
 * Which tone an office character is showing.
 *
 * Errors win over work: a failed agent that is still technically mid-run is a
 * problem to look at, not progress to admire.
 */
export const resolveOfficeAgentTone = (input: {
  isError?: boolean;
  isWorking?: boolean;
}): OfficeStatusTone => {
  if (input.isError) return "error";
  if (input.isWorking) return "working";
  return "idle";
};

export const resolveOfficeAgentHex = (input: {
  isError?: boolean;
  isWorking?: boolean;
}): string => OFFICE_STATUS_HEX[resolveOfficeAgentTone(input)];

export const resolveOfficeAgentDotClass = (input: {
  isError?: boolean;
  isWorking?: boolean;
}): string => OFFICE_STATUS_DOT_CLASS[resolveOfficeAgentTone(input)];

export const resolveOfficeAgentPillClass = (input: {
  isError?: boolean;
  isWorking?: boolean;
}): string => OFFICE_STATUS_PILL_CLASS[resolveOfficeAgentTone(input)];

/** Word shown next to the dot, kept in step with the tone it labels. */
export const OFFICE_STATUS_LABEL: Record<OfficeStatusTone, string> = {
  working: "working",
  idle: "idle",
  attention: "waiting",
  error: "error",
  done: "done",
};

export const resolveOfficeAgentLabel = (input: {
  isError?: boolean;
  isWorking?: boolean;
}): string => OFFICE_STATUS_LABEL[resolveOfficeAgentTone(input)];
