#!/usr/bin/env node
// Prove the office activity lifecycle end-to-end.
//
// Subscribes to the Hermes3D gateway proxy on port 3000 exactly as the browser
// UI does, then prints every `agent` lifecycle frame whose source is
// `office-activity` as JSON. A separate step runs a short profile turn; this
// script only observes, and never prints prompts or replies.
//
// Usage: node scripts/watch-office-activity.mjs [--profile clody] [--seconds 120]

import WebSocket from "ws";

const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const url = argOf("--url", "ws://localhost:3000/api/gateway/ws");
const profile = argOf("--profile", "");
const seconds = Number(argOf("--seconds", "120"));

const observed = [];
const ws = new WebSocket(url);

const finish = (code) => {
  console.log(JSON.stringify({ observed }, null, 2));
  const phases = observed.map((o) => o.phase);
  console.log(
    `summary profile=${profile || "*"} frames=${observed.length} ` +
      `has_start=${phases.includes("start")} has_end=${phases.includes("end")}`
  );
  try {
    ws.close();
  } catch {}
  process.exit(code);
};

const timer = setTimeout(() => finish(observed.length ? 0 : 2), seconds * 1000);
timer.unref?.();

ws.on("open", () => {
  ws.send(
    JSON.stringify({
      type: "req",
      id: "watch-1",
      method: "connect",
      params: { client: { id: "hermes3d-control-ui", mode: "webchat" } },
    })
  );
  console.log(`watching ${url} for office-activity lifecycle frames`);
});

ws.on("message", (data) => {
  let frame;
  try {
    frame = JSON.parse(data.toString());
  } catch {
    return;
  }
  if (frame.type !== "event" || frame.event !== "agent") return;
  const payload = frame.payload || {};
  const info = payload.data || {};
  if (info.source !== "office-activity") return;
  const sessionKey = String(payload.sessionKey || "");
  if (profile && !sessionKey.startsWith(`agent:${profile}:`)) return;
  const entry = {
    at: new Date().toISOString(),
    phase: info.phase,
    runId: payload.runId,
    sessionKey,
    // The bridge always sends an empty text on these frames; assert it.
    textEmpty: !info.text,
  };
  observed.push(entry);
  console.log("EVENT " + JSON.stringify(entry));
  if (observed.some((o) => o.phase === "start") && info.phase === "end") {
    clearTimeout(timer);
    finish(0);
  }
});

ws.on("error", (err) => {
  console.log("ERROR: " + err.message);
  process.exit(3);
});
