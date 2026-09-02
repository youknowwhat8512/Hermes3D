#!/usr/bin/env node
// Probe the same-origin gateway WebSocket proxy the browser UI uses.
// Sends a connect frame and prints the first response frame, then exits.
// Usage: node scripts/probe-gateway-ws.mjs [wsUrl]

import WebSocket from "ws";

const url = process.argv[2] || "ws://localhost:3000/api/gateway/ws";
const ws = new WebSocket(url);
const timer = setTimeout(() => {
  console.log("TIMEOUT: no response within 15s");
  process.exit(2);
}, 15000);

ws.on("open", () => {
  ws.send(
    JSON.stringify({
      type: "req",
      id: "probe-1",
      method: "connect",
      params: {
        client: { id: "hermes3d-control-ui", mode: "webchat" },
      },
    })
  );
});

ws.on("message", (data) => {
  clearTimeout(timer);
  const text = data.toString();
  console.log("FRAME:", text.slice(0, 800));
  ws.close();
  process.exit(0);
});

ws.on("error", (err) => {
  clearTimeout(timer);
  console.log("ERROR:", err.message);
  process.exit(3);
});
