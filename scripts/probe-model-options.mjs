#!/usr/bin/env node
// Read-only probe: how many models each model.options provider row exposes.
import WebSocket from "ws";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const env = readFileSync(join(here, "..", ".env"), "utf8");
const token =
  env
    .split(/\r?\n/)
    .find((line) => line.startsWith("HERMES3D_GATEWAY_TOKEN="))
    ?.slice("HERMES3D_GATEWAY_TOKEN=".length)
    .trim() ?? "";

const base = process.argv[2] || "http://localhost:9137";
const wsUrl = `${base.replace(/^http/, "ws").replace(/\/$/, "")}/api/ws?token=${encodeURIComponent(token)}`;
const ws = new WebSocket(wsUrl, { headers: { Host: "localhost" } });
setTimeout(() => {
  console.log("TIMEOUT");
  process.exit(2);
}, 40000);

ws.on("message", (raw) => {
  const frame = JSON.parse(raw.toString());
  if (frame.method === "event" && frame.params?.type === "gateway.ready") {
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "model.options", params: {} }));
    return;
  }
  if (frame.id === 1) {
    const providers = frame.result?.providers ?? [];
    for (const row of providers) {
      console.log(
        row.slug,
        "total:",
        row.total_models,
        "sample:",
        JSON.stringify((row.models ?? []).slice(0, 4)),
      );
    }
    ws.close();
    process.exit(0);
  }
});
ws.on("error", (err) => {
  console.log("ERROR:", err.message);
  process.exit(3);
});
