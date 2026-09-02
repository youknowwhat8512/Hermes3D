/**
 * Translates the Hermes3D gateway protocol into hermes-agent's JSON-RPC 2.0 API.
 *
 * hermes-agent has no server that speaks the Hermes3D protocol — that protocol
 * came from OpenClaw. Rather than run a separate adapter process, this module
 * presents a virtual upstream to `gateway-proxy.js`: it exposes the small slice
 * of the `ws` WebSocket surface the proxy actually uses (`readyState`, `send`,
 * `close`, `terminate`, and the open/message/close/error events), so the proxy's
 * connect handling and lifecycle stay untouched.
 *
 * Hermes3D talks in agents and session keys; hermes-agent talks in runtime
 * session ids. A hermes-agent backend is a single agent, so the fleet is
 * synthesised as one entry and session keys are mapped onto runtime sessions
 * that are created or resumed on first use.
 */

const { EventEmitter } = require("node:events");
const { createHash, randomUUID } = require("node:crypto");

const { HermesAgentJsonRpcClient, redactUrl } = require("./jsonrpc-client");
const { createOfficeSpeechSubscriber } = require("./office-speech");
const { createOfficeActivityTracker } = require("./office-activity");
const {
  KANBAN_ACTIVITY_POLL_INTERVAL_MS,
  createKanbanActivityTracker,
} = require("./kanban-activity");
const {
  KANBAN_TASK_ID_PREFIX,
  toHermes3dKanbanTaskRecord,
  toHermes3dKanbanTasks,
  toKanbanRunningByAssignee,
  toKanbanPatchBody,
  kanbanRequest,
} = require("./kanban");

/** Mirrors the numeric WebSocket readyState constants the proxy compares against. */
const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

const AGENT_ID = "hermes";
const AGENT_NAME = "Hermes";
const MAIN_KEY = "main";
const MAIN_SESSION_KEY = `agent:${AGENT_ID}:${MAIN_KEY}`;

/** hermes-agent's `session.create` / `session.resume` can be slow on a cold profile. */
const SESSION_RPC_TIMEOUT_MS = 60_000;

/**
 * How often abandoned external turns are swept.
 *
 * A publisher that dies mid-turn never sends its end frame; without this the
 * character it started would stay green until the page is reloaded.
 */
const OFFICE_ACTIVITY_PRUNE_INTERVAL_MS = 60_000;

/**
 * Profile discovery is identical for tabs aimed at the same authenticated
 * backend. Reusing it briefly avoids a profiles.list burst during tab reloads
 * while keeping roster changes visible within a bounded window.
 */
const AGENT_ROSTER_CACHE_TTL_MS = 5_000;
const AGENT_ROSTER_CACHE_MAX_ENTRIES = 8;
const agentRosterCache = new Map();
const agentRosterLoads = new Map();
const agentRosterLoadGenerations = new Map();
const agentRosterActiveLoads = new Map();

class StaleAgentRosterLoadError extends Error {
  constructor() {
    super("Agent roster load was invalidated.");
    this.name = "StaleAgentRosterLoadError";
  }
}

/**
 * The slice of the `ws` WebSocket surface `gateway-proxy.js` relies on.
 *
 * @typedef {import("node:events").EventEmitter & {
 *   readyState: number,
 *   send: (raw: string) => void,
 *   close: (code?: number, reason?: string) => void,
 *   terminate: () => void,
 * }} HermesAgentUpstream
 */

const resOk = (id, payload) => ({ type: "res", id, ok: true, payload: payload ?? {} });
const resErr = (id, code, message) => ({ type: "res", id, ok: false, error: { code, message } });

const asString = (value, fallback = "") =>
  typeof value === "string" && value.trim() ? value.trim() : fallback;

const errorMessage = (err) => {
  if (!err) return "hermes-agent request failed";
  if (typeof err === "string") return err;
  return err.message || String(err);
};

/** hermes-agent history rows use `text`; Hermes3D expects `content`. */
const toHermes3dMessages = (messages) => {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant"))
    .map((m) => ({
      role: m.role,
      content: typeof m.text === "string" ? m.text : String(m.content ?? ""),
    }));
};

const parseTimestampMs = (value) => {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
};

const DURATION_UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * hermes-agent stores a schedule as one string; Hermes3D wants a tagged union.
 *
 * The string is a 5-field cron expression, a duration such as "30m", or an ISO
 * timestamp for a one-shot job.
 */
const toHermes3dSchedule = (raw) => {
  const value = asString(raw);
  if (!value) return { kind: "cron", expr: "" };

  const duration = /^every\s+(\d+)\s*([smhd])$/i.exec(value) || /^(\d+)\s*([smhd])$/i.exec(value);
  if (duration) {
    const unit = DURATION_UNIT_MS[duration[2].toLowerCase()];
    if (unit) return { kind: "every", everyMs: Number(duration[1]) * unit };
  }

  if (value.split(/\s+/).length === 5) return { kind: "cron", expr: value };

  const at = parseTimestampMs(value);
  if (at !== undefined) return { kind: "at", at: value };

  return { kind: "cron", expr: value };
};

const CRON_STATUSES = new Set(["ok", "error", "skipped"]);

/**
 * Translate hermes-agent cron rows into Hermes3D's `CronJobSummary`.
 *
 * The two shapes disagree on nearly every field: hermes-agent uses `job_id`, a
 * schedule string, `prompt_preview`, ISO timestamps, and a `state` *string*,
 * while Hermes3D expects `id`, a schedule object, a `payload` object, epoch
 * milliseconds, and a `state` object. Forwarding the raw rows crashes the
 * office task board, which reads `job.payload.kind` unguarded.
 */
const toHermes3dCronJobs = (jobs, agentId = AGENT_ID) => {
  if (!Array.isArray(jobs)) return [];
  return jobs
    .filter((job) => job && typeof job === "object")
    .map((job) => {
      const nextRunAtMs = parseTimestampMs(job.next_run_at);
      const lastRunAtMs = parseTimestampMs(job.last_run_at);
      const lastStatus = asString(job.last_status).toLowerCase();
      const lastError = asString(job.last_fire_error) || asString(job.last_delivery_error);
      const message =
        asString(job.prompt_preview) || asString(job.name) || "Scheduled job";

      return {
        id: asString(job.job_id) || asString(job.id),
        name: asString(job.name) || asString(job.job_id) || "Scheduled job",
        agentId,
        description: asString(job.prompt_preview) || undefined,
        enabled: job.enabled !== false,
        updatedAtMs: lastRunAtMs ?? nextRunAtMs ?? Date.now(),
        schedule: toHermes3dSchedule(job.schedule),
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message },
        state: {
          ...(nextRunAtMs !== undefined ? { nextRunAtMs } : {}),
          ...(lastRunAtMs !== undefined ? { lastRunAtMs } : {}),
          ...(asString(job.state).toLowerCase() === "running"
            ? { runningAtMs: Date.now() }
            : {}),
          ...(CRON_STATUSES.has(lastStatus) ? { lastStatus } : {}),
          ...(lastError ? { lastError } : {}),
        },
        delivery: { mode: asString(job.deliver) && job.deliver !== "none" ? "announce" : "none" },
      };
    })
    .filter((job) => job.id);
};

/** Used when the backend predates `profiles.list` or the call fails. */
const fallbackAgent = () => ({
  id: AGENT_ID,
  name: AGENT_NAME,
  workspace: "",
  identity: { name: AGENT_NAME, emoji: "🤖" },
  role: "",
  model: "",
  provider: "",
  profile: "",
});

/** Title-case a profile directory name for display ("allan" -> "Allan"). */
const toDisplayName = (name) =>
  name ? name.charAt(0).toUpperCase() + name.slice(1) : "";

/**
 * Turn hermes-agent's profile list into Hermes3D agents.
 *
 * A profile is the backend's unit of identity — its own model, skills, memory
 * and sessions — which is exactly what Hermes3D calls an agent. Collapsing them
 * into one entry hides the operator's whole fleet, so each profile gets a desk.
 *
 * The `profile` field is what routes sessions back; the default profile carries
 * an empty string because omitting `profile` means "launch profile" upstream.
 *
 * `model` and `provider` are the profile's live pin. Both travel together
 * because a model id alone is ambiguous — the same name is served by different
 * providers (claude-sonnet-4-6 via `claude-cli` or `anthropic`), and the office
 * keys its model dropdown on `provider/model`.
 */
const toHermes3dAgents = (profiles) => {
  if (!Array.isArray(profiles)) return [];
  const agents = profiles
    .filter((p) => p && typeof p === "object" && asString(p.name))
    .map((p) => {
      const name = asString(p.name);
      const isDefault = p.is_default === true;
      const display = asString(p.display_name) || toDisplayName(name);
      // The long profile descriptions read as a role ("Allan — technical
      // planner…"); keep the part after the dash so the desk label stays short.
      const description = asString(p.description);
      const role = description.includes("—")
        ? description.split("—").slice(1).join("—").trim()
        : description;
      return {
        id: name,
        name: display,
        workspace: asString(p.path),
        identity: { name: display, emoji: isDefault ? "🤖" : "🧑‍💻" },
        role,
        model: asString(p.model),
        provider: asString(p.provider),
        isDefault,
        profile: isDefault ? "" : name,
      };
    });
  return agents;
};

const resolveDefaultAgentId = (agents) => {
  const explicit = agents.find((a) => a.isDefault);
  return explicit?.id ?? agents[0]?.id ?? AGENT_ID;
};

const agentRosterCacheKey = (url, token) =>
  createHash("sha256")
    .update(String(url ?? ""))
    .update("\0")
    .update(String(token ?? ""))
    .digest("hex");

const trackedAgentRosterKeyCount = () =>
  new Set([
    ...agentRosterCache.keys(),
    ...agentRosterLoads.keys(),
    ...agentRosterActiveLoads.keys(),
  ]).size;

const pruneAgentRosterCache = () => {
  while (agentRosterCache.size > AGENT_ROSTER_CACHE_MAX_ENTRIES) {
    const oldest = agentRosterCache.keys().next().value;
    if (oldest === undefined) break;
    agentRosterCache.delete(oldest);
    if (!agentRosterLoads.has(oldest) && !agentRosterActiveLoads.has(oldest)) {
      agentRosterLoadGenerations.delete(oldest);
    }
  }
};

const startAgentRosterLoad = (key, load) => {
  const generation = agentRosterLoadGenerations.get(key) ?? 0;
  agentRosterActiveLoads.set(key, (agentRosterActiveLoads.get(key) ?? 0) + 1);
  const entry = { promise: null };
  entry.promise = Promise.resolve()
    .then(load)
    .then((profiles) => {
      if ((agentRosterLoadGenerations.get(key) ?? 0) !== generation) {
        throw new StaleAgentRosterLoadError();
      }
      const normalized = Array.isArray(profiles) ? profiles : [];
      agentRosterCache.set(key, {
        profiles: normalized,
        expiresAt: Date.now() + AGENT_ROSTER_CACHE_TTL_MS,
        generation,
      });
      pruneAgentRosterCache();
      return normalized;
    })
    .finally(() => {
      if (agentRosterLoads.get(key) === entry) {
        agentRosterLoads.delete(key);
      }
      const active = (agentRosterActiveLoads.get(key) ?? 1) - 1;
      if (active > 0) {
        agentRosterActiveLoads.set(key, active);
      } else {
        agentRosterActiveLoads.delete(key);
        if (!agentRosterCache.has(key) && !agentRosterLoads.has(key)) {
          agentRosterLoadGenerations.delete(key);
        }
      }
    });
  agentRosterLoads.set(key, entry);
  return entry.promise;
};

const loadCachedAgentProfiles = async (key, load, retryDepth = 0) => {
  const now = Date.now();
  const generation = agentRosterLoadGenerations.get(key) ?? 0;
  const cached = agentRosterCache.get(key);
  if (cached && cached.expiresAt > now && cached.generation === generation) {
    // Refresh insertion order so pruning behaves as a tiny LRU.
    agentRosterCache.delete(key);
    agentRosterCache.set(key, cached);
    return cached.profiles;
  }
  if (cached) agentRosterCache.delete(key);

  const inFlight = agentRosterLoads.get(key);
  if (inFlight) {
    try {
      return await inFlight.promise;
    } catch (err) {
      // A shared loader belongs to another disposable tab. Give a still-live
      // follower one request through its own client instead of inheriting the
      // leader's close failure.
      if (retryDepth === 0) {
        return loadCachedAgentProfiles(key, load, retryDepth + 1);
      }
      throw err;
    }
  }

  const isKnownKey =
    agentRosterLoadGenerations.has(key) ||
    agentRosterCache.has(key) ||
    agentRosterActiveLoads.has(key);
  if (!isKnownKey && trackedAgentRosterKeyCount() >= AGENT_ROSTER_CACHE_MAX_ENTRIES) {
    const profiles = await load();
    return Array.isArray(profiles) ? profiles : [];
  }

  try {
    return await startAgentRosterLoad(key, load);
  } catch (err) {
    if (err instanceof StaleAgentRosterLoadError && retryDepth === 0) {
      return loadCachedAgentProfiles(key, load, retryDepth + 1);
    }
    throw err;
  }
};

const invalidateAgentRosterCache = (key) => {
  agentRosterLoadGenerations.set(
    key,
    (agentRosterLoadGenerations.get(key) ?? 0) + 1
  );
  agentRosterCache.delete(key);
  // Detach the old generation immediately so nobody can join it. Its promise
  // still settles for its original waiter, but generation validation prevents
  // it from publishing stale data.
  agentRosterLoads.delete(key);
  if (!agentRosterActiveLoads.has(key)) {
    agentRosterLoadGenerations.delete(key);
  }
};

/**
 * The office keys every model on `provider/model` and labels it "model ·
 * provider", so both halves travel together everywhere.
 */
const toHermes3dModel = (provider, model) => ({
  id: model,
  name: `${model} · ${provider}`,
  provider,
});

/**
 * Flatten hermes-agent's `model.options` into Hermes3D model choices.
 *
 * The backend groups models under provider rows (`{slug, models: [...]}`);
 * Hermes3D wants one flat list where each entry names its provider, because a
 * bare model id is ambiguous — `claude-sonnet-4-6` is served both by
 * `anthropic` and by `claude-cli`, and switching to the wrong one fails.
 */
const toHermes3dModels = (providerRows) => {
  if (!Array.isArray(providerRows)) return [];
  const models = [];
  const seen = new Set();
  for (const row of providerRows) {
    if (!row || typeof row !== "object") continue;
    const provider = asString(row.slug) || asString(row.provider);
    if (!provider) continue;
    for (const raw of Array.isArray(row.models) ? row.models : []) {
      const model = asString(raw) || asString(raw?.id) || asString(raw?.name);
      if (!model) continue;
      const key = `${provider}/${model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      models.push(toHermes3dModel(provider, model));
    }
  }
  return models;
};

/**
 * Add the models the fleet is actually pinned to.
 *
 * A profile can run a provider that never appears in `model.options` — a CLI
 * bridge such as `claude-cli` has no catalog to enumerate — and without this
 * merge that desk's own model is missing from its own dropdown, which is what
 * made the office fall back to a placeholder.
 */
const withRosterModels = (models, agents) => {
  const merged = [...models];
  const seen = new Set(merged.map((entry) => `${entry.provider}/${entry.id}`));
  for (const agent of Array.isArray(agents) ? agents : []) {
    const provider = asString(agent?.provider);
    const model = asString(agent?.model);
    if (!provider || !model) continue;
    const key = `${provider}/${model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(toHermes3dModel(provider, model));
  }
  return merged;
};

/**
 * Translate the office's `provider/model` key into hermes-agent's `/model`
 * grammar (`<model> --provider <slug>`).
 *
 * Only the first segment is the provider: aggregator model ids carry their own
 * slashes (`openrouter/anthropic/claude-x`), so the rest is the model verbatim.
 * A value with no provider prefix is passed through untouched.
 */
const toModelSwitchValue = (raw) => {
  const value = asString(raw);
  if (!value) return { value: "", model: "", provider: "" };
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    return { value, model: value, provider: "" };
  }
  const provider = value.slice(0, slash);
  const model = value.slice(slash + 1);
  return { value: `${model} --provider ${provider}`, model, provider };
};

/**
 * The confirmation hermes-agent is waiting on, or "" when the write went through.
 *
 * `config.set` answers a guarded model (expensive tier, data-training policy)
 * with `confirm_required` and a *successful* JSON-RPC result. Treating that as
 * a save is how a rejected write gets reported to the operator as applied.
 */
const modelConfirmMessage = (result) =>
  result && result.confirm_required === true
    ? asString(
        result.confirm_message,
        "hermes-agent needs confirmation before switching to this model."
      )
    : "";


function createHermesAgentUpstream(options) {
  const {
    url,
    token,
    handshakeTimeoutMs,
    log = () => {},
    logError = () => {},
  } = options || {};

  const upstream = /** @type {HermesAgentUpstream} */ (new EventEmitter());
  upstream.readyState = CONNECTING;

  let client;
  try {
    client = new HermesAgentJsonRpcClient({ url, token, handshakeTimeoutMs, log });
  } catch (err) {
    // Defer so the caller can attach listeners before the failure lands.
    setImmediate(() => upstream.emit("error", err));
    upstream.readyState = CLOSED;
    upstream.send = () => {};
    upstream.close = () => {};
    upstream.terminate = () => {};
    return upstream;
  }
  const rosterCacheKey = agentRosterCacheKey(url, token);

  /** sessionKey -> { runtimeId, storedId, title } */
  const sessions = new Map();
  /** runtime session id -> sessionKey */
  const sessionKeyByRuntimeId = new Map();
  /**
   * Hermes3D agents, one per hermes-agent profile.
   *
   * Profiles are the backend's fleet: each is a fully isolated instance with
   * its own model, skills, memory, and session store. Resolved once at connect
   * because the set only changes when the operator creates or deletes one.
   */
  let agentRoster = [fallbackAgent()];
  let defaultAgentId = AGENT_ID;
  /** Optional feed of turns driven from other clients; see ./office-speech.js. */
  let officeSpeech = null;
  /**
   * Externally driven turns, reconciled against the runs this bridge owns.
   * See ./office-activity.js for why a tracker is needed rather than a relay.
   */
  const officeActivity = createOfficeActivityTracker();
  let officeActivityPruneTimer = null;
  /**
   * Kanban workers, which publish nothing at all.
   * See ./kanban-activity.js for why the board has to be polled instead.
   */
  const kanbanActivity = createKanbanActivityTracker();
  let kanbanActivityPollTimer = null;
  let kanbanActivityPollInFlight = false;
  /** runId -> { sessionKey, runtimeId, buffer, aborted } */
  const activeRuns = new Map();
  /** sessionKey -> runId, so session-scoped events find their run. */
  const runBySessionKey = new Map();
  /**
   * sessionKey -> when this bridge last observed real work on it.
   *
   * Only genuine signals are recorded (a prompt going out, a reply coming
   * back, an external turn); nothing stamps "now" merely because a listing was
   * requested, which is what made every desk look busy.
   */
  const sessionActivityAt = new Map();
  const markSessionActivity = (sessionKey, atMs = Date.now()) => {
    if (!sessionKey) return;
    sessionActivityAt.set(sessionKey, atMs);
  };

  let seq = 0;
  let closed = false;

  const emitFrame = (frame) => {
    if (closed) return;
    upstream.emit("message", JSON.stringify(frame));
  };

  const emitEvent = (event, payload) => {
    emitFrame({ type: "event", event, seq: seq++, payload });
  };

  const emitChat = (runId, sessionKey, state, extra) => {
    emitEvent("chat", { runId, sessionKey, state, ...extra });
  };

  // --- session mapping ------------------------------------------------------

  const rememberSession = (sessionKey, result) => {
    const runtimeId = asString(result?.session_id);
    if (!runtimeId) throw new Error("hermes-agent did not return a session id.");
    const entry = {
      runtimeId,
      storedId: asString(result?.stored_session_id) || asString(result?.session_key),
      title: asString(result?.info?.title) || asString(result?.title),
    };
    sessions.set(sessionKey, entry);
    sessionKeyByRuntimeId.set(runtimeId, sessionKey);
    return entry;
  };

  /**
   * Split `agent:<agentId>:<tail>` into the agent and the stored session id.
   */
  const parseSessionKey = (sessionKey) => {
    const parts = String(sessionKey ?? "").split(":");
    if (parts[0] !== "agent" || parts.length < 3) {
      return { agentId: defaultAgentId, tail: "" };
    }
    return { agentId: parts[1] || defaultAgentId, tail: parts.slice(2).join(":") };
  };

  /**
   * The `profile` value to send upstream for an agent.
   *
   * Empty means "the launch profile", which is what hermes-agent expects for
   * the default; naming it explicitly is unnecessary and, for a backend with no
   * profiles at all, would be rejected.
   */
  const profileForAgent = (agentId) => {
    const agent = agentRoster.find((a) => a.id === agentId);
    return agent ? asString(agent.profile) : "";
  };

  /** Main session of whichever agent is default; the roster is known only at runtime. */
  const defaultMainKey = () => `agent:${defaultAgentId}:${MAIN_KEY}`;

  /**
   * Resolve the runtime session backing a Hermes3D session key, creating or
   * resuming one on hermes-agent the first time the key is used.
   *
   * The agent segment of the key selects the profile, so a prompt sent to
   * `agent:allan:main` runs with Allan's model, skills, and session store.
   */
  const ensureSession = async (sessionKey) => {
    const existing = sessions.get(sessionKey);
    if (existing?.runtimeId) return existing;

    const { agentId, tail } = parseSessionKey(sessionKey);
    const profile = profileForAgent(agentId);
    const scope = profile ? { profile } : {};

    // A key of the form `agent:<id>:<storedId>` refers to a stored hermes-agent
    // session; anything else starts a fresh one.
    if (tail && tail !== MAIN_KEY) {
      try {
        const resumed = await client.request(
          "session.resume",
          { session_id: tail, omit_messages: false, ...scope },
          SESSION_RPC_TIMEOUT_MS
        );
        return rememberSession(sessionKey, resumed);
      } catch (err) {
        log(`[hermes-agent] resume of "${tail}" failed, creating a new session: ${errorMessage(err)}`);
      }
    }

    const created = await client.request("session.create", scope, SESSION_RPC_TIMEOUT_MS);
    log(`[hermes-agent] session for "${sessionKey}" -> profile "${profile || "(default)"}"`);
    return rememberSession(sessionKey, created);
  };

  // --- upstream event fan-out ----------------------------------------------

  client.on("event", (type, runtimeSessionId, payload) => {
    const sessionKey = sessionKeyByRuntimeId.get(runtimeSessionId);
    if (!sessionKey) return;
    const runId = runBySessionKey.get(sessionKey);
    const run = runId ? activeRuns.get(runId) : null;

    switch (type) {
      case "message.start":
        if (run) run.buffer = "";
        return;

      case "message.delta": {
        if (!run || run.aborted) return;
        const text = typeof payload?.text === "string" ? payload.text : "";
        if (!text) return;
        run.buffer += text;
        emitChat(runId, sessionKey, "delta", {
          message: { role: "assistant", content: run.buffer },
        });
        return;
      }

      case "message.complete": {
        if (!run) return;
        const finalText =
          typeof payload?.text === "string" && payload.text ? payload.text : run.buffer;
        if (run.aborted) {
          emitChat(runId, sessionKey, "aborted", {});
        } else if (payload?.status === "error" || payload?.error) {
          emitChat(runId, sessionKey, "error", {
            errorMessage: asString(payload?.error, "hermes-agent reported an error"),
          });
        } else {
          emitChat(runId, sessionKey, "final", {
            stopReason: "end_turn",
            message: { role: "assistant", content: finalText },
          });
          const completedAt = Date.now();
          markSessionActivity(sessionKey, completedAt);
          emitEvent("presence", {
            sessions: {
              recent: [{ key: sessionKey, updatedAt: completedAt }],
              byAgent: [
                {
                  agentId: parseSessionKey(sessionKey).agentId,
                  recent: [{ key: sessionKey, updatedAt: completedAt }],
                },
              ],
            },
          });
        }
        activeRuns.delete(runId);
        runBySessionKey.delete(sessionKey);
        return;
      }

      case "tool.start":
        if (!run) return;
        emitEvent("agent", {
          runId,
          sessionKey,
          stream: "tool",
          data: { phase: "start", name: asString(payload?.name), text: asString(payload?.context) },
        });
        return;

      case "tool.complete":
        if (!run) return;
        emitEvent("agent", {
          runId,
          sessionKey,
          stream: "tool",
          data: { phase: "complete", name: asString(payload?.name), text: asString(payload?.summary) },
        });
        return;

      case "reasoning.delta":
      case "thinking.delta":
        if (!run) return;
        emitEvent("agent", {
          runId,
          sessionKey,
          stream: "reasoning",
          data: { phase: "delta", text: typeof payload?.text === "string" ? payload.text : "" },
        });
        return;

      case "status.update":
        if (!run) return;
        emitEvent("agent", {
          runId,
          sessionKey,
          stream: "lifecycle",
          data: { phase: asString(payload?.kind, "status"), text: asString(payload?.text) },
        });
        return;

      case "approval.request":
        emitEvent("exec.approval.requested", {
          id: asString(payload?.request_id),
          request: { command: asString(payload?.command), cwd: asString(payload?.cwd) },
          createdAtMs: Date.now(),
          expiresAtMs: Date.now() + 120_000,
        });
        return;

      case "error":
        if (!run) return;
        emitChat(runId, sessionKey, "error", {
          errorMessage: asString(payload?.message, "hermes-agent reported an error"),
        });
        activeRuns.delete(runId);
        runBySessionKey.delete(sessionKey);
        return;

      default:
    }
  });

  // --- method dispatch ------------------------------------------------------

  /** Load the fleet through a short bounded cache shared by same-backend tabs. */
  const loadAgentRoster = async () => {
    try {
      const profiles = await loadCachedAgentProfiles(
        rosterCacheKey,
        async () => {
          const result = await client.request("profiles.list", {}, SESSION_RPC_TIMEOUT_MS);
          return result?.profiles;
        }
      );
      if (closed) return;
      const mapped = toHermes3dAgents(profiles);
      if (mapped.length > 0) {
        agentRoster = mapped;
        defaultAgentId = resolveDefaultAgentId(mapped);
        log(`[hermes-agent] ${mapped.length} profile(s) mapped to agents: ${mapped.map((a) => a.id).join(", ")}`);
        return;
      }
      log("[hermes-agent] profiles.list returned nothing; using a single agent");
    } catch (err) {
      log(`[hermes-agent] profiles.list unavailable (${errorMessage(err)}); using a single agent`);
    }
  };

  /**
   * Relay a turn published by the office bridge plugin.
   *
   * The plugin names the profile that spoke, and Hermes3D names each agent
   * after its profile, so the two line up directly. A turn from a profile this
   * connection does not know about is dropped rather than guessed at.
   */
  const handlePublishedTurn = (turn) => {
    const agent = agentRoster.find((a) => a.id === turn.profile);
    if (!agent) {
      log(`[office-speech] no agent for profile "${turn.profile}"; turn ignored`);
      return;
    }
    emitEvent("office.speech", {
      agentId: agent.id,
      name: agent.name,
      text: turn.text,
      atMs: turn.atMs,
      sessionId: turn.sessionId,
    });
  };

  /**
   * Emit one externally driven lifecycle transition.
   *
   * The office already reacts to `agent` lifecycle events for runs it started
   * itself, so reusing that stream means an outside turn lights the same
   * character the same way — no separate presence path to keep in sync.
   *
   * Deliberately no `presence` event. The client turns presence into a summary
   * refresh, and that static hydration overwrites the live agent state — which
   * cleared the desk in the middle of a turn that was still running. The
   * freshness bookkeeping this frame implies is kept locally instead, where
   * `sessions.list` reads it, so the desk is coloured by the lifecycle stream
   * alone.
   *
   * A repeated `start` is the plugin's heartbeat for a turn still in flight.
   * It is emitted as-is, carrying the same run id as the first one, so a desk
   * cleared by a hydration or a browser reconnect is relit on the next beat.
   */
  const emitActivityLifecycle = (decision, source = "office-activity") => {
    if (!decision || decision.action === "ignore") return;
    markSessionActivity(decision.sessionKey, decision.atMs);
    emitEvent("agent", {
      runId: decision.runId,
      sessionKey: decision.sessionKey,
      stream: "lifecycle",
      data: {
        phase: decision.action,
        // Never the prompt or the reply: this frame exists to colour a desk.
        text: "",
        source,
      },
    });
  };

  /**
   * Relay a lifecycle frame published by the office bridge plugin.
   *
   * A turn this bridge is driving already streams its own chat lifecycle, so
   * those are recognised by their runtime session id and skipped; what is left
   * is exactly the work started somewhere else.
   */
  const handlePublishedActivity = (activity) => {
    const agent = agentRoster.find((a) => a.id === activity.profile);
    if (!agent) return;
    const localSessionKey = activity.sessionId
      ? sessionKeyByRuntimeId.get(activity.sessionId)
      : undefined;
    const ownedByBridge = Boolean(
      localSessionKey && runBySessionKey.has(localSessionKey)
    );
    const decision = officeActivity.plan({
      agentId: agent.id,
      sessionKey: localSessionKey || `agent:${agent.id}:${MAIN_KEY}`,
      sessionId: activity.sessionId,
      phase: activity.phase,
      atMs: activity.atMs,
      ownedByBridge,
    });
    emitActivityLifecycle(decision);
  };

  const startOfficeSpeech = () => {
    if (officeSpeech) return;
    officeSpeech = createOfficeSpeechSubscriber({
      url,
      token,
      onTurn: handlePublishedTurn,
      onActivity: handlePublishedActivity,
      log,
    });
    if (officeActivityPruneTimer) return;
    officeActivityPruneTimer = setInterval(() => {
      for (const decision of officeActivity.prune(Date.now())) {
        emitActivityLifecycle(decision);
      }
    }, OFFICE_ACTIVITY_PRUNE_INTERVAL_MS);
    if (typeof officeActivityPruneTimer.unref === "function") {
      officeActivityPruneTimer.unref();
    }
  };

  /**
   * Agents whose desk is already lit by a lifecycle this connection owns.
   *
   * A turn driven from Hermes3D and a turn republished by the office bridge
   * plugin both already run the character; the board must not start a second,
   * competing run for the same agent.
   */
  const busyAgentIds = () => {
    const busy = new Set(officeActivity.activeAgentIds());
    for (const sessionKey of runBySessionKey.keys()) {
      busy.add(parseSessionKey(sessionKey).agentId);
    }
    return busy;
  };

  /** Every agent's main session key, which is the desk the board colours. */
  const mainSessionKeyByAgentId = () =>
    new Map(agentRoster.map((agent) => [agent.id, `agent:${agent.id}:${MAIN_KEY}`]));

  /**
   * Read the board once and emit whatever changed.
   *
   * Failures are handed to the tracker rather than logged and dropped: it owns
   * the grace window that decides when an unreadable board finally means the
   * work stopped.
   */
  const pollKanbanActivity = async () => {
    if (closed || kanbanActivityPollInFlight) return;
    kanbanActivityPollInFlight = true;
    try {
      const board = await kanbanRequest({
        wsUrl: url,
        token,
        useLoopbackHost: client.usedLoopbackHost,
        method: "GET",
        path: "/board?include_archived=false",
      });
      if (closed) return;
      const decisions = kanbanActivity.observe({
        runningByAgent: toKanbanRunningByAssignee(board),
        sessionKeyByAgentId: mainSessionKeyByAgentId(),
        busyAgentIds: busyAgentIds(),
        atMs: Date.now(),
      });
      for (const decision of decisions) {
        emitActivityLifecycle(decision, "kanban-activity");
      }
    } catch {
      if (closed) return;
      for (const decision of kanbanActivity.observeError(Date.now())) {
        emitActivityLifecycle(decision, "kanban-activity");
      }
    } finally {
      kanbanActivityPollInFlight = false;
    }
  };

  const startKanbanActivity = () => {
    if (kanbanActivityPollTimer) return;
    // An immediate read so a worker already running when the office opens is
    // green on the first frame rather than one poll later.
    void pollKanbanActivity();
    kanbanActivityPollTimer = setInterval(() => {
      void pollKanbanActivity();
    }, KANBAN_ACTIVITY_POLL_INTERVAL_MS);
    if (typeof kanbanActivityPollTimer.unref === "function") {
      kanbanActivityPollTimer.unref();
    }
  };

  const stopKanbanActivity = () => {
    if (kanbanActivityPollTimer) {
      clearInterval(kanbanActivityPollTimer);
      kanbanActivityPollTimer = null;
    }
    kanbanActivity.reset();
  };

  const handleConnect = async (id) => {
    await loadAgentRoster();
    if (closed) {
      return resErr(id, "hermes_agent.connect_cancelled", "Connection closed during setup.");
    }
    // Only worth subscribing once the roster exists to map turns onto.
    startOfficeSpeech();
    // Same reason: an assignee is only a desk if it names an agent we have.
    startKanbanActivity();
    const agents = agentRoster.map((a) => ({
      agentId: a.id,
      name: a.name,
      isDefault: a.id === defaultAgentId,
      model: asString(a.model),
      provider: asString(a.provider),
    }));
    return resOk(id, {
      type: "hello-ok",
      protocol: 3,
      // The client trusts this over the configured type once connected, so
      // report what the backend actually is — hermes-agent capabilities
      // (native kanban, profile fleet) hang off this detection.
      adapterType: "hermes-agent",
      features: {
        methods: [
          "agents.list",
          "agents.files.get",
          "agents.files.set",
          "sessions.list",
          "sessions.preview",
          "sessions.patch",
          "sessions.reset",
          "chat.send",
          "chat.abort",
          "chat.history",
          "agent.wait",
          "status",
          "config.get",
          "config.set",
          "config.patch",
          "exec.approvals.get",
          "exec.approvals.set",
          "exec.approval.resolve",
          "wake",
          "skills.status",
          "models.list",
          "tasks.list",
          "tasks.update",
          "cron.list",
        ],
        events: ["chat", "agent", "presence", "heartbeat", "cron"],
      },
      snapshot: {
        health: { agents, defaultAgentId },
        sessionDefaults: { mainKey: MAIN_KEY },
      },
      auth: { role: "operator", scopes: ["operator.admin", "operator.approvals"] },
      policy: { tickIntervalMs: 30_000 },
    });
  };

  const handleMethod = async (method, params, id) => {
    const p = params || {};

    switch (method) {
      case "agents.list":
        return resOk(id, {
          defaultId: defaultAgentId,
          mainKey: MAIN_KEY,
          agents: agentRoster.map(
            ({ id: agentId, name, workspace, identity, role, model, provider }) => ({
              id: agentId,
              name,
              workspace,
              identity,
              role,
              model: asString(model),
              provider: asString(provider),
            })
          ),
        });

      case "agents.files.get":
        return resOk(id, { file: { missing: true } });

      case "agents.files.set":
        return resOk(id, {});

      case "config.get":
        return resOk(id, {
          config: { gateway: { reload: { mode: "hot" } } },
          hash: "hermes-agent",
          exists: true,
          path: "",
        });

      case "config.patch":
      case "config.set":
        return resOk(id, { hash: "hermes-agent" });

      case "sessions.list": {
        // Callers ask per agent (`agentId`), and answering with the whole
        // fleet made every caller's "latest activity" read another profile's
        // rows. Honour the filter; an unknown id yields nothing rather than
        // everything.
        const requestedAgentId = asString(p.agentId);
        const scopedRoster = requestedAgentId
          ? agentRoster.filter((agent) => agent.id === requestedAgentId)
          : agentRoster;
        // Each profile keeps its own session store, so the stored rows have to
        // be read per agent; they're local SQLite reads, so fan out in parallel.
        const perAgent = await Promise.all(
          scopedRoster.map(async (agent) => {
            const profile = asString(agent.profile);
            // The profile's own pin is what its sessions actually run on;
            // reporting a placeholder here is what showed the wrong model on
            // every desk. Omit the fields entirely when the backend gave us
            // nothing rather than inventing a value.
            const agentModel = asString(agent.model);
            const agentProvider = asString(agent.provider);
            const modelFields = {
              ...(agentModel ? { model: agentModel } : {}),
              ...(agentProvider ? { modelProvider: agentProvider } : {}),
            };
            const origin = {
              label: agent.name,
              ...(agentProvider ? { provider: agentProvider } : {}),
            };
            let stored = [];
            try {
              const result = await client.request("session.list", {
                limit: 20,
                ...(profile ? { profile } : {}),
              });
              stored = Array.isArray(result?.sessions) ? result.sessions : [];
            } catch (err) {
              log(`[hermes-agent] session.list for "${agent.id}" failed: ${errorMessage(err)}`);
            }
            const mainKey = `agent:${agent.id}:${MAIN_KEY}`;
            // `Date.now()` here made every listing look like the agent had
            // just been active, which is the signal the office reads to decide
            // who is working. Report the real time this bridge last saw the
            // main session, and null when it has never been used.
            const mainUpdatedAt = sessionActivityAt.get(mainKey) ?? null;
            return [
              {
                key: mainKey,
                agentId: agent.id,
                updatedAt: mainUpdatedAt,
                displayName: "Main",
                origin,
                ...modelFields,
              },
              ...stored.map((s) => ({
                key: `agent:${agent.id}:${asString(s.id)}`,
                agentId: agent.id,
                updatedAt: typeof s.started_at === "number" ? s.started_at * 1000 : null,
                displayName: asString(s.title, "Session"),
                origin,
                ...modelFields,
              })),
            ];
          })
        );
        return resOk(id, { sessions: perAgent.flat() });
      }

      case "sessions.preview": {
        const keys = Array.isArray(p.keys) ? p.keys : [];
        const limit = typeof p.limit === "number" ? p.limit : 8;
        const maxChars = typeof p.maxChars === "number" ? p.maxChars : 240;
        const previews = await Promise.all(
          keys.map(async (key) => {
            const entry = sessions.get(key);
            if (!entry?.runtimeId) return { key, status: "empty", items: [] };
            try {
              const history = await client.request("session.history", {
                session_id: entry.runtimeId,
              });
              const items = toHermes3dMessages(history?.messages)
                .slice(-limit)
                .map((m) => ({
                  role: m.role,
                  text: m.content.slice(0, maxChars),
                  timestamp: Date.now(),
                }));
              return { key, status: items.length ? "ok" : "empty", items };
            } catch {
              return { key, status: "empty", items: [] };
            }
          })
        );
        return resOk(id, { ts: Date.now(), previews });
      }

      case "sessions.patch": {
        const key = asString(p.key, defaultMainKey());
        const switched = toModelSwitchValue(p.model);
        if (!switched.value) {
          return resOk(id, {
            ok: true,
            key,
            entry: { thinkingLevel: p.thinkingLevel },
            resolved: {},
          });
        }

        // Picking a model in the office is a change to the PROFILE, not just
        // to this conversation: the operator expects new sessions and other
        // clients to come up on it too. So the durable write happens first and
        // the live session only follows once it landed — a session-only switch
        // that silently forgot itself is the bug this ordering closes.
        const { agentId } = parseSessionKey(key);
        const agent = agentRoster.find((a) => a.id === agentId);
        const profileName = agent ? asString(agent.profile) : "";

        try {
          if (profileName) {
            // A named profile owns its own config.yaml; `profiles.configure`
            // is the only call that writes it without moving this process's
            // HERMES_HOME. It needs both halves of the pin.
            if (!switched.provider) {
              return resErr(
                id,
                "hermes_agent.model_provider_required",
                `Cannot set "${profileName}" default model: "${switched.model}" arrived without a provider.`
              );
            }
            const configured = await client.request(
              "profiles.configure",
              { name: profileName, model: switched.model, provider: switched.provider },
              SESSION_RPC_TIMEOUT_MS
            );
            // `profiles.configure` applies each section best-effort and reports
            // per-section success, so a 200 alone proves nothing.
            if (configured?.applied?.model !== true) {
              return resErr(
                id,
                "hermes_agent.profile_model_write_failed",
                `hermes-agent did not save "${switched.model}" as profile "${profileName}"'s default model.`
              );
            }
          } else {
            // The default profile has no `profiles/<name>` directory, so its
            // default lives in the root config — written through the same
            // `/model --global` grammar the CLI and TUI persist with.
            const persisted = await client.request("config.set", {
              key: "model",
              value: `${switched.value} --global`,
            });
            const confirm = modelConfirmMessage(persisted);
            if (confirm) {
              return resErr(id, "hermes_agent.model_confirm_required", confirm);
            }
          }
        } catch (err) {
          return resErr(
            id,
            "hermes_agent.model_persist_failed",
            `Saving "${switched.model}" as "${agentId}"'s default model failed: ${errorMessage(err)}`
          );
        }

        // A model write changes profile discovery output. Do not hand a newly
        // opened tab the pre-write roster during the bounded cache window.
        invalidateAgentRosterCache(rosterCacheKey);

        // Only now is the roster telling the truth; sessions.list and the next
        // hello report the pin that is actually on disk.
        if (agent) {
          agent.model = switched.model;
          if (switched.provider) agent.provider = switched.provider;
        }

        let pendingTurn = false;
        try {
          const entry = await ensureSession(key);
          const applied = await client.request("config.set", {
            key: "model",
            // hermes-agent parses `/model` grammar, not `provider/model`:
            // sending the office key verbatim makes it hunt for a model
            // literally named "anthropic/claude-opus-4-5".
            value: switched.value,
            session_id: entry.runtimeId,
          });
          const confirm = modelConfirmMessage(applied);
          if (confirm) {
            return resErr(id, "hermes_agent.model_confirm_required", confirm);
          }
          // A turn already streaming can't swap model mid-flight; hermes-agent
          // stashes the pick and applies it at the next turn instead.
          pendingTurn = applied?.deferred === true;
        } catch (err) {
          return resErr(
            id,
            "hermes_agent.session_model_switch_failed",
            `Saved "${switched.model}" as "${agentId}"'s default model, but this session did not switch: ${errorMessage(err)}. New sessions will use "${switched.model}".`
          );
        }

        return resOk(id, {
          ok: true,
          key,
          entry: { thinkingLevel: p.thinkingLevel },
          resolved: {
            model: switched.model,
            ...(switched.provider ? { modelProvider: switched.provider } : {}),
            scope: "profile",
            profile: agentId,
            ...(pendingTurn ? { pendingTurn: true } : {}),
          },
        });
      }

      case "sessions.reset": {
        const key = asString(p.key, defaultMainKey());
        const entry = sessions.get(key);
        if (entry?.runtimeId) {
          sessionKeyByRuntimeId.delete(entry.runtimeId);
          try {
            await client.request("session.close", { session_id: entry.runtimeId });
          } catch {}
        }
        sessions.delete(key);
        return resOk(id, { ok: true });
      }

      case "chat.send": {
        const sessionKey = asString(p.sessionKey, defaultMainKey());
        const text =
          typeof p.message === "string" ? p.message.trim() : String(p.message ?? "").trim();
        const runId = asString(p.idempotencyKey) || randomUUID();
        if (!text) return resOk(id, { status: "no-op", runId });

        let entry;
        try {
          entry = await ensureSession(sessionKey);
        } catch (err) {
          return resErr(id, "hermes_agent.session_failed", errorMessage(err));
        }

        activeRuns.set(runId, { sessionKey, runtimeId: entry.runtimeId, buffer: "", aborted: false });
        runBySessionKey.set(sessionKey, runId);

        try {
          await client.request("prompt.submit", { session_id: entry.runtimeId, text });
        } catch (err) {
          activeRuns.delete(runId);
          runBySessionKey.delete(sessionKey);
          return resErr(id, "hermes_agent.prompt_failed", errorMessage(err));
        }
        markSessionActivity(sessionKey);

        return resOk(id, { status: "started", runId });
      }

      case "chat.abort": {
        const runId = asString(p.runId);
        const sessionKey = asString(p.sessionKey);
        const targets = runId
          ? [runId]
          : [...activeRuns.entries()]
              .filter(([, run]) => run.sessionKey === sessionKey)
              .map(([rid]) => rid);

        let aborted = 0;
        for (const rid of targets) {
          const run = activeRuns.get(rid);
          if (!run) continue;
          run.aborted = true;
          aborted += 1;
          try {
            await client.request("session.interrupt", { session_id: run.runtimeId });
          } catch (err) {
            log(`[hermes-agent] interrupt failed: ${errorMessage(err)}`);
          }
        }
        return resOk(id, { ok: true, aborted });
      }

      case "chat.history": {
        const sessionKey = asString(p.sessionKey, defaultMainKey());
        const entry = sessions.get(sessionKey);
        if (!entry?.runtimeId) return resOk(id, { sessionKey, messages: [] });
        try {
          const history = await client.request("session.history", {
            session_id: entry.runtimeId,
          });
          return resOk(id, { sessionKey, messages: toHermes3dMessages(history?.messages) });
        } catch (err) {
          log(`[hermes-agent] session.history failed: ${errorMessage(err)}`);
          return resOk(id, { sessionKey, messages: [] });
        }
      }

      case "agent.wait": {
        const runId = asString(p.runId);
        const timeoutMs = typeof p.timeoutMs === "number" ? p.timeoutMs : 30_000;
        const start = Date.now();
        while (activeRuns.has(runId) && Date.now() - start < timeoutMs) {
          await new Promise((r) => setTimeout(r, 100));
        }
        return resOk(id, { status: activeRuns.has(runId) ? "running" : "done" });
      }

      case "status": {
        // Same rule as sessions.list: report when work was actually seen, not
        // the time of the poll. A session this bridge has never driven has no
        // activity to report, so it is left out entirely rather than being
        // stamped with now.
        const recent = [...sessions.keys()].flatMap((key) => {
          const updatedAt = sessionActivityAt.get(key);
          return typeof updatedAt === "number" ? [{ key, updatedAt }] : [];
        });
        const byAgent = agentRoster.map((agent) => ({
          agentId: agent.id,
          recent: recent.filter((entry) => parseSessionKey(entry.key).agentId === agent.id),
        }));
        return resOk(id, { sessions: { recent, byAgent } });
      }

      case "wake": {
        const text = asString(p.text);
        if (!text) return resOk(id, { ok: true });
        try {
          const entry = await ensureSession(defaultMainKey());
          await client.request("prompt.submit", { session_id: entry.runtimeId, text });
        } catch (err) {
          log(`[hermes-agent] wake failed: ${errorMessage(err)}`);
        }
        return resOk(id, { ok: true });
      }

      case "models.list": {
        // The roster's own pins are always offered, even when the catalog is
        // unavailable — a desk must at least be able to show what it runs on.
        // Nothing is synthesised: an empty list is the honest answer when the
        // backend knows of no models at all.
        try {
          const result = await client.request("model.options", {});
          return resOk(id, {
            models: withRosterModels(toHermes3dModels(result?.providers), agentRoster),
          });
        } catch (err) {
          log(`[hermes-agent] model.options unavailable: ${errorMessage(err)}`);
          return resOk(id, { models: withRosterModels([], agentRoster) });
        }
      }

      case "skills.status": {
        try {
          const result = await client.request("skills.manage", { action: "list" });
          const skills = Array.isArray(result?.skills) ? result.skills : [];
          return resOk(id, { skills });
        } catch {
          return resOk(id, { skills: [] });
        }
      }

      case "cron.list": {
        try {
          // cron.manage reads the launch profile's scheduler, so the jobs
          // belong to whichever agent that profile maps to.
          const result = await client.request("cron.manage", { action: "list" });
          return resOk(id, { jobs: toHermes3dCronJobs(result?.jobs, defaultAgentId) });
        } catch (err) {
          log(`[hermes-agent] cron.manage failed: ${errorMessage(err)}`);
          return resOk(id, { jobs: [] });
        }
      }

      case "exec.approvals.get":
        return resOk(id, {
          path: "",
          exists: true,
          hash: "hermes-agent",
          file: {
            version: 1,
            defaults: { security: "full", ask: "off", autoAllowSkills: true },
            agents: {},
          },
        });

      case "exec.approvals.set":
        return resOk(id, { hash: "hermes-agent" });

      case "exec.approval.resolve": {
        const requestId = asString(p.id);
        const decision = asString(p.decision, "deny");
        const runtimeId = [...sessions.values()][0]?.runtimeId;
        if (requestId && runtimeId) {
          try {
            await client.request("approval.respond", {
              session_id: runtimeId,
              request_id: requestId,
              choice: decision === "allow" ? "once" : "deny",
            });
          } catch (err) {
            log(`[hermes-agent] approval.respond failed: ${errorMessage(err)}`);
          }
        }
        return resOk(id, { ok: true });
      }

      // Kanban is built into hermes-agent — the board rides the same origin
      // and session token as the JSON-RPC gateway, so the office task board
      // reflects the real `hermes kanban` board with nothing to install.
      case "tasks.list": {
        try {
          const includeArchived = p.includeArchived === false ? "false" : "true";
          const board = await kanbanRequest({
            wsUrl: url,
            token,
            useLoopbackHost: client.usedLoopbackHost,
            method: "GET",
            path: `/board?include_archived=${includeArchived}`,
          });
          return resOk(id, { tasks: toHermes3dKanbanTasks(board) });
        } catch (err) {
          // A hidden/disabled kanban plugin or older backend is not an error
          // state for the office — the board just has no hermes tasks.
          log(`[hermes-agent] kanban board unavailable: ${errorMessage(err)}`);
          return resOk(id, { tasks: [] });
        }
      }

      case "tasks.update": {
        const rawId = asString(p.id);
        if (!rawId.startsWith(KANBAN_TASK_ID_PREFIX)) {
          return resErr(
            id,
            "hermes_agent.tasks_update_unsupported",
            "Only Hermes kanban tasks can be updated on this backend.",
          );
        }
        const taskId = rawId.slice(KANBAN_TASK_ID_PREFIX.length);
        try {
          const result = await kanbanRequest({
            wsUrl: url,
            token,
            useLoopbackHost: client.usedLoopbackHost,
            method: "PATCH",
            path: `/tasks/${encodeURIComponent(taskId)}`,
            body: toKanbanPatchBody(p),
          });
          const record = toHermes3dKanbanTaskRecord(result?.task);
          if (!record) {
            return resErr(
              id,
              "hermes_agent.tasks_update_failed",
              "hermes-agent did not return the updated task.",
            );
          }
          return resOk(id, record);
        } catch (err) {
          return resErr(id, "hermes_agent.tasks_update_failed", errorMessage(err));
        }
      }

      default:
        log(`[hermes-agent] unhandled method: ${method}`);
        return resOk(id, {});
    }
  };

  // --- virtual WebSocket surface -------------------------------------------

  upstream.send = (raw) => {
    let frame;
    try {
      frame = JSON.parse(String(raw ?? ""));
    } catch {
      return;
    }
    if (!frame || frame.type !== "req") return;

    const { id, method, params } = frame;
    const respond = (result) => emitFrame(result);

    if (method === "connect") {
      handleConnect(id).then(respond, (err) =>
        respond(resErr(id, "hermes_agent.connect_failed", errorMessage(err)))
      );
      return;
    }

    handleMethod(method, params, id).then(respond, (err) => {
      logError(`[hermes-agent] method "${method}" failed.`, err);
      respond(resErr(id, "hermes_agent.request_failed", errorMessage(err)));
    });
  };

  const stopOfficeSpeech = () => {
    officeSpeech?.close();
    officeSpeech = null;
    if (officeActivityPruneTimer) {
      clearInterval(officeActivityPruneTimer);
      officeActivityPruneTimer = null;
    }
    officeActivity.reset();
    stopKanbanActivity();
  };

  upstream.close = (code, reason) => {
    closed = true;
    upstream.readyState = CLOSED;
    stopOfficeSpeech();
    client.close(code, reason);
  };

  upstream.terminate = () => {
    closed = true;
    upstream.readyState = CLOSED;
    stopOfficeSpeech();
    client.terminate();
  };

  client.on("ready", () => {
    upstream.readyState = OPEN;
    log(`[hermes-agent] JSON-RPC gateway ready at ${redactUrl(client.url)}`);
    upstream.emit("open");
  });

  client.on("close", (code, reason) => {
    closed = true;
    upstream.readyState = CLOSED;
    stopOfficeSpeech();
    upstream.emit("close", code, Buffer.from(String(reason ?? "")));
  });

  client.on("error", (err) => {
    upstream.emit("error", err);
  });

  client.connect();

  return upstream;
}

module.exports = {
  createHermesAgentUpstream,
  toHermes3dMessages,
  toHermes3dCronJobs,
  toHermes3dSchedule,
  toHermes3dAgents,
  toHermes3dModels,
  withRosterModels,
  toModelSwitchValue,
  resolveDefaultAgentId,
  MAIN_SESSION_KEY,
  AGENT_ID,
};
