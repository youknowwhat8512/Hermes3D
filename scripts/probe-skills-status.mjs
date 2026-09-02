#!/usr/bin/env node
// Read-only probe: connect through the same-origin gateway proxy and dump the
// hello frame features plus the raw skills.status payload shape.
// Usage: node scripts/probe-skills-status.mjs [wsUrl] [agentId]

import WebSocket from "ws";

const url = process.argv[2] || "ws://localhost:3000/api/gateway/ws";
const agentId = process.argv[3] || "main";
const ws = new WebSocket(url);
const timer = setTimeout(() => {
  console.log("TIMEOUT");
  process.exit(2);
}, 20000);

let helloSeen = false;

ws.on("open", () => {
  ws.send(
    JSON.stringify({
      type: "req",
      id: "probe-connect",
      method: "connect",
      params: { client: { id: "hermes3d-control-ui", mode: "webchat" } },
    })
  );
});

ws.on("message", (data) => {
  const text = data.toString();
  let frame;
  try {
    frame = JSON.parse(text);
  } catch {
    return;
  }
  if (!helloSeen && (frame.type === "hello-ok" || frame.payload?.type === "hello-ok" || frame.payload?.features)) {
    helloSeen = true;
    const payload = frame.type === "hello-ok" ? frame : frame.payload ?? {};
    console.log("ADAPTER:", payload.adapterType);
    console.log("METHODS:", JSON.stringify(payload.features?.methods ?? null));
    console.log("HAS agents.create:", Boolean(payload.features?.methods?.includes("agents.create")));
    ws.send(
      JSON.stringify({
        type: "req",
        id: "probe-skills",
        method: "skills.status",
        params: { agentId },
      })
    );
    return;
  }
  if (frame.id === "probe-skills") {
    clearTimeout(timer);
    const payload = frame.payload ?? {};
    console.log("SKILLS.STATUS KEYS:", JSON.stringify(Object.keys(payload)));
    console.log("workspaceDir:", JSON.stringify(payload.workspaceDir));
    console.log("managedSkillsDir:", JSON.stringify(payload.managedSkillsDir));
    const first = Array.isArray(payload.skills) ? payload.skills[0] : null;
    console.log("skills count:", Array.isArray(payload.skills) ? payload.skills.length : "n/a");
    console.log("first entry:", JSON.stringify(first)?.slice(0, 600));
    ws.close();
    process.exit(0);
  }
});

ws.on("error", (err) => {
  clearTimeout(timer);
  console.log("ERROR:", err.message);
  process.exit(3);
});
