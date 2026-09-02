#!/usr/bin/env node
// Read-only live check of the Hermes3D-facing gateway proxy: connect, then
// report the roster size and the model/provider each desk would display.
// Usage: node scripts/probe-office-models.mjs [wsUrl]

import WebSocket from "ws";

const url = process.argv[2] || "ws://localhost:3000/api/gateway/ws";
const ws = new WebSocket(url);
const timer = setTimeout(() => {
  console.log("TIMEOUT");
  process.exit(2);
}, 60000);

const send = (id, method, params = {}) =>
  ws.send(JSON.stringify({ type: "req", id, method, params }));

ws.on("open", () => send("c1", "connect", { client: { id: "hermes3d-control-ui", mode: "webchat" } }));

const state = {};

ws.on("message", (raw) => {
  let frame;
  try {
    frame = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (frame.type !== "res") return;

  if (frame.id === "c1") {
    const agents = frame.payload?.snapshot?.health?.agents ?? [];
    console.log("HELLO agents:", agents.length);
    for (const a of agents) {
      console.log(`  ${a.agentId}: ${a.model || "(none)"} · ${a.provider || "(none)"}`);
    }
    send("a1", "agents.list");
    return;
  }
  if (frame.id === "a1") {
    state.agents = frame.payload?.agents ?? [];
    console.log("agents.list count:", state.agents.length);
    send("s1", "sessions.list");
    return;
  }
  if (frame.id === "s1") {
    const sessions = frame.payload?.sessions ?? [];
    const mains = sessions.filter((s) => s.key.endsWith(":main"));
    console.log("sessions.list main rows:", mains.length);
    for (const s of mains) {
      console.log(`  ${s.key}: model=${s.model ?? "(none)"} provider=${s.modelProvider ?? "(none)"}`);
    }
    send("m1", "models.list");
    return;
  }
  if (frame.id === "m1") {
    const models = frame.payload?.models ?? [];
    console.log("models.list count:", models.length);
    console.log("has fake hermes entry:", models.some((m) => m.id === "hermes"));
    const wanted = ["claude-opus-4-5", "claude-sonnet-4-6", "gpt-5.6-sol"];
    for (const id of wanted) {
      const hits = models.filter((m) => m.id === id);
      console.log(`  ${id}:`, JSON.stringify(hits));
    }
    clearTimeout(timer);
    ws.close();
    process.exit(0);
  }
});

ws.on("error", (err) => {
  clearTimeout(timer);
  console.log("ERROR:", err.message);
  process.exit(3);
});
