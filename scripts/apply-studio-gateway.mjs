#!/usr/bin/env node
/**
 * Point the persisted Studio gateway profile at a given upstream URL via the app's
 * official PUT /api/studio route (no direct edits to the settings file).
 *
 * Usage:
 *   node scripts/apply-studio-gateway.mjs <gatewayUrl> [appOrigin]
 *
 * The token is read from ja-office/.env (HERMES3D_GATEWAY_TOKEN) and is never printed.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(here, "..");

const gatewayUrl = process.argv[2];
const appOrigin = process.argv[3] ?? "http://localhost:3000";
if (!gatewayUrl) {
  console.error("usage: node scripts/apply-studio-gateway.mjs <gatewayUrl> [appOrigin]");
  process.exit(2);
}

const readEnvValue = (key) => {
  const envPath = path.join(repoDir, ".env");
  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    if (trimmed.slice(0, eq).trim() !== key) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return "";
};

const token = readEnvValue("HERMES3D_GATEWAY_TOKEN");
if (!token) {
  console.error("HERMES3D_GATEWAY_TOKEN not found in .env");
  process.exit(2);
}

const adapterType = readEnvValue("HERMES3D_GATEWAY_ADAPTER_TYPE") || "hermes-agent";

const body = {
  gateway: {
    url: gatewayUrl,
    token,
    adapterType,
    lastKnownGood: { url: gatewayUrl, adapterType },
  },
};

const response = await fetch(`${appOrigin}/api/studio`, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const text = await response.text();
console.log("status:", response.status);
try {
  const parsed = JSON.parse(text);
  console.log("gateway:", JSON.stringify(parsed?.settings?.gateway ?? null, null, 2));
} catch {
  console.log("body:", text.slice(0, 500));
}
process.exit(response.ok ? 0 : 1);
