#!/usr/bin/env node
// Read-only probe of the hermes-agent JSON-RPC backend: dumps profiles.list
// rows (name/model/provider) and the shape of model.options.
// Usage: node scripts/probe-profiles-models.mjs [httpUrl]
// Token is read from ja-office/.env (never printed).

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
const wsUrl = `${base.replace(/^http/, "ws").replace(/\/$/, "")}/api/ws${
  token ? `?token=${encodeURIComponent(token)}` : ""
}`;

const ws = new WebSocket(wsUrl, { headers: { Host: "localhost" } });
const timer = setTimeout(() => {
  console.log("TIMEOUT");
  process.exit(2);
}, 30000);

let nextId = 1;
const pending = new Map();
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });

ws.on("message", async (raw) => {
  const frame = JSON.parse(raw.toString());
  if (frame.id !== undefined && pending.has(frame.id)) {
    const { resolve, reject } = pending.get(frame.id);
    pending.delete(frame.id);
    if (frame.error) reject(new Error(JSON.stringify(frame.error)));
    else resolve(frame.result);
    return;
  }
  if (frame.method === "event" && frame.params?.type === "gateway.ready") {
    try {
      const profiles = await call("profiles.list", { include_sessions: false });
      console.log(
        "PROFILES:",
        JSON.stringify(
          (profiles?.profiles ?? []).map((p) => ({
            name: p.name,
            is_default: p.is_default,
            model: p.model,
            provider: p.provider,
            display_name: p.display_name,
          })),
          null,
          2,
        ),
      );
    } catch (err) {
      console.log("profiles.list FAILED:", err.message);
    }
    try {
      const options = await call("model.options", {});
      const providers = Array.isArray(options?.providers) ? options.providers : [];
      console.log("model.options provider count:", providers.length);
      console.log("model.options current:", JSON.stringify({ model: options?.model, provider: options?.provider }));
      console.log(
        "first provider row keys:",
        JSON.stringify(providers[0] ? Object.keys(providers[0]) : null),
      );
      console.log(
        "provider slugs:",
        JSON.stringify(providers.map((row) => row.slug).slice(0, 20)),
      );
    } catch (err) {
      console.log("model.options FAILED:", err.message);
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
