// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const { buildJsonRpcUrl, redactUrl } = await import("../../server/hermes-agent/jsonrpc-client");
const { createHermesAgentUpstream, toHermes3dMessages } = await import(
  "../../server/hermes-agent/bridge"
);

type Frame = Record<string, unknown>;
type RpcHandler = (
  params: Frame,
  emit: (type: string, payload: Frame) => void,
) => Frame | void | Promise<Frame | void>;

/** Read a dotted path out of a decoded frame without widening everything to `any`. */
const at = (source: unknown, path: string): unknown =>
  path
    .split(".")
    .reduce<unknown>((acc, key) => (acc as Record<string, unknown> | undefined)?.[key], source);

const servers: { close: (done: () => void) => void }[] = [];
const upstreams: { terminate: () => void }[] = [];

afterEach(async () => {
  for (const upstream of upstreams.splice(0)) {
    try {
      upstream.terminate();
    } catch {}
  }
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/**
 * Minimal stand-in for hermes-agent's /api/ws: emits gateway.ready on connect,
 * answers JSON-RPC requests from `handlers`, and lets a handler push events.
 *
 * The same origin also answers `/api/plugins/kanban/board`, because that is
 * how the real backend ships kanban — the board rides the JSON-RPC port — and
 * the bridge polls it to colour desks for workers that publish nothing.
 */
const startFakeHermesAgent = async (
  handlers: Record<string, RpcHandler>,
  kanban: { board?: () => unknown; status?: number } = {},
) => {
  const boardRequests: number[] = [];
  const httpServer = createServer((req, res) => {
    if (!String(req.url ?? "").startsWith("/api/plugins/kanban/board")) {
      res.writeHead(404).end("{}");
      return;
    }
    boardRequests.push(Date.now());
    const status = kanban.status ?? 200;
    if (status >= 300) {
      res.writeHead(status, { "Content-Type": "application/json" }).end("{}");
      return;
    }
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify(kanban.board?.() ?? { columns: [] }));
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));

  const wss = new WebSocketServer({ server: httpServer });
  servers.push({
    close: (done) => {
      wss.close(() => {
        httpServer.closeAllConnections?.();
        httpServer.close(() => done());
      });
    },
  });

  const received: Frame[] = [];
  /** Sockets the office bridge opened to subscribe to published frames. */
  const eventSubscribers: WsSocket[] = [];

  wss.on("connection", (ws: WsSocket, req) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    received.push({ __connect: true, path: url.pathname, token: url.searchParams.get("token") });

    // The bridge also subscribes to the dashboard event bus; that socket
    // speaks published frames, not JSON-RPC, so keep the two apart.
    if (url.pathname === "/api/events") {
      eventSubscribers.push(ws);
      return;
    }

    const send = (obj: unknown) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(obj));
    };
    const emit = (type: string, payload: Frame) =>
      send({ jsonrpc: "2.0", method: "event", params: { type, session_id: "s1", payload } });

    send({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: {} } });

    ws.on("message", async (raw) => {
      const request = JSON.parse(String(raw)) as Frame;
      received.push(request);
      const handler = handlers[String(request.method)];
      if (!handler) {
        send({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32601, message: "unknown method" },
        });
        return;
      }
      // A handler that throws stands in for an upstream JSON-RPC error, which
      // is what a real backend answers with — not a dropped request.
      let result;
      try {
        result = await handler((request.params ?? {}) as Frame, emit);
      } catch (err) {
        send({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32000, message: (err as Error).message },
        });
        return;
      }
      send({ jsonrpc: "2.0", id: request.id, result: result ?? {} });
    });
  });

  /** Publish a frame the way the office bridge plugin does. */
  const publish = async (frame: Record<string, unknown>) => {
    const start = Date.now();
    while (eventSubscribers.length === 0 && Date.now() - start < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const socket = eventSubscribers[eventSubscribers.length - 1];
    if (!socket) throw new Error("the bridge never subscribed to the event bus");
    socket.send(JSON.stringify(frame));
  };

  const { port } = wss.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}`,
    received,
    publish,
    boardRequests,
    eventSubscriberCount: () => eventSubscribers.filter((socket) => socket.readyState === 1).length,
  };
};

/** Drive the bridge and collect the frames it sends back toward the browser. */
const openBridge = async (url: string, token = "") => {
  const frames: Frame[] = [];
  const upstream = createHermesAgentUpstream({ url, token });
  upstreams.push(upstream);
  upstream.on("message", (raw: string) => frames.push(JSON.parse(raw) as Frame));

  await new Promise<void>((resolve, reject) => {
    upstream.on("open", () => resolve());
    upstream.on("error", reject);
    setTimeout(() => reject(new Error("bridge did not open")), 5000);
  });

  const send = (frame: Frame) => upstream.send(JSON.stringify(frame));

  const waitFor = async (predicate: (frame: Frame) => boolean, label: string) => {
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const hit = frames.find(predicate);
      if (hit) return hit;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for ${label}; saw ${JSON.stringify(frames)}`);
  };

  return { upstream, frames, send, waitFor };
};

describe("buildJsonRpcUrl", () => {
  it("appends the gateway path and maps https to wss", () => {
    expect(buildJsonRpcUrl("https://host.ts.net:8443", "abc")).toBe(
      "wss://host.ts.net:8443/api/ws?token=abc",
    );
  });

  it("keeps a path the caller already supplied", () => {
    expect(buildJsonRpcUrl("wss://host.ts.net:8443/api/ws", "")).toBe(
      "wss://host.ts.net:8443/api/ws",
    );
  });

  it("maps http to ws and tolerates a trailing slash", () => {
    expect(buildJsonRpcUrl("http://localhost:9119/", "t")).toBe(
      "ws://localhost:9119/api/ws?token=t",
    );
  });

  it("rejects a scheme that is not http(s) or ws(s)", () => {
    expect(() => buildJsonRpcUrl("ftp://host", "")).toThrow(/Unsupported scheme/);
  });

  it("keeps the token out of logged URLs", () => {
    expect(redactUrl("wss://h/api/ws?token=secret")).toBe("wss://h/api/ws?token=***");
  });
});

describe("loopback Host fallback", () => {
  /**
   * Stands in for a loopback-bound hermes-agent behind Tailscale Serve, which
   * forwards the client's Host verbatim: the tailnet name is refused with 4403
   * and only a loopback Host gets through.
   */
  const startHostStrictAgent = async () => {
    const wss = new WebSocketServer({ port: 0 });
    servers.push(wss);
    await new Promise<void>((resolve) => wss.on("listening", () => resolve()));

    const hostsSeen: string[] = [];
    wss.on("connection", (ws: WsSocket, req) => {
      const host = String(req.headers.host ?? "");
      hostsSeen.push(host);
      const hostOnly = host.split(":")[0].toLowerCase();
      if (!["localhost", "127.0.0.1", "::1"].includes(hostOnly)) {
        ws.close(4403, "host_mismatch");
        return;
      }
      ws.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: {} } }));
    });

    const { port } = wss.address() as AddressInfo;
    return { port, hostsSeen };
  };

  it("retries with a loopback Host when the backend refuses the forwarded one", async () => {
    const { port, hostsSeen } = await startHostStrictAgent();
    const { HermesAgentJsonRpcClient } = await import("../../server/hermes-agent/jsonrpc-client");

    // 127.0.0.1 resolves, but the Host header carries a name the backend rejects.
    const client = new HermesAgentJsonRpcClient({ url: `ws://127.0.0.1:${port}`, token: "t" });
    client.hostHeader = "box.ts.net";
    client.loopbackHostFallback = true;

    const ready = new Promise<void>((resolve, reject) => {
      client.on("ready", () => resolve());
      client.on("close", (code: number) => reject(new Error(`closed ${code}`)));
      setTimeout(() => reject(new Error("never became ready")), 5000);
    });
    client.connect();
    await ready;

    expect(hostsSeen[0]).toBe("box.ts.net");
    expect(hostsSeen[1]).toBe("localhost");
    expect(client.usedLoopbackHost).toBe(true);
    client.terminate();
  });

  it("retries when the upgrade is refused with HTTP 403 before accepting", async () => {
    // How a loopback-bound hermes-agent actually refuses a foreign Host on
    // /api/ws: the handshake is rejected outright rather than accepted-then-closed.
    const hostsSeen: string[] = [];
    const wss = new WebSocketServer({
      port: 0,
      verifyClient: ({ req }, done) => {
        const host = String(req.headers.host ?? "");
        hostsSeen.push(host);
        done(host.split(":")[0].toLowerCase() === "localhost", 403);
      },
    });
    servers.push(wss);
    await new Promise<void>((resolve) => wss.on("listening", () => resolve()));
    wss.on("connection", (ws: WsSocket) => {
      ws.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: {} } }));
    });
    const { port } = wss.address() as AddressInfo;

    const { HermesAgentJsonRpcClient } = await import("../../server/hermes-agent/jsonrpc-client");
    const client = new HermesAgentJsonRpcClient({ url: `ws://127.0.0.1:${port}`, token: "t" });
    client.hostHeader = "box.ts.net";

    const ready = new Promise<void>((resolve, reject) => {
      client.on("ready", () => resolve());
      client.on("error", (e: Error) => reject(e));
      setTimeout(() => reject(new Error("never became ready")), 5000);
    });
    client.connect();
    await ready;

    expect(hostsSeen[0]).toBe("box.ts.net");
    expect(hostsSeen[1]).toBe("localhost");
    client.terminate();
  });

  it("gives up after one retry rather than looping", async () => {
    const wss = new WebSocketServer({ port: 0 });
    servers.push(wss);
    await new Promise<void>((resolve) => wss.on("listening", () => resolve()));
    let attempts = 0;
    wss.on("connection", (ws: WsSocket) => {
      attempts += 1;
      ws.close(4403, "host_mismatch");
    });
    const { port } = wss.address() as AddressInfo;

    const { HermesAgentJsonRpcClient } = await import("../../server/hermes-agent/jsonrpc-client");
    const client = new HermesAgentJsonRpcClient({ url: `ws://127.0.0.1:${port}`, token: "t" });

    const closed = new Promise<number>((resolve) => client.on("close", (code: number) => resolve(code)));
    client.connect();
    expect(await closed).toBe(4403);
    expect(attempts).toBe(2);
  });
});

describe("profiles as agents", () => {
  // Verbatim rows from a live hermes-agent `profiles.list`.
  const backendProfiles = [
    {
      name: "default",
      path: "/Users/lukeai1/.hermes",
      is_default: true,
      model: "claude-haiku-4-5-20251001",
      provider: "anthropic",
      description: "",
      display_name: "",
    },
    {
      name: "allan",
      path: "/Users/lukeai1/.hermes/profiles/allan",
      is_default: false,
      model: "claude-haiku-4-5-20251001",
      provider: "claude-cli",
      description:
        "Allan — technical planner and business systems analyst for Smartways. Converts Jira tickets into plans.",
      display_name: "",
    },
    {
      name: "andrew",
      path: "/Users/lukeai1/.hermes/profiles/andrew",
      is_default: false,
      model: "gpt-5.6-sol",
      provider: "openai-codex",
      description: "Andrew — senior full-stack software developer for Smartways.",
      display_name: "",
    },
  ];

  it("gives every profile its own agent", async () => {
    const { toHermes3dAgents } = await import("../../server/hermes-agent/bridge");
    const agents = toHermes3dAgents(backendProfiles);
    expect(agents.map((a) => a.id)).toEqual(["default", "allan", "andrew"]);
    expect(agents.map((a) => a.name)).toEqual(["Default", "Allan", "Andrew"]);
  });

  it("keeps each profile's real model and provider", async () => {
    const { toHermes3dAgents } = await import("../../server/hermes-agent/bridge");
    const [def, allan, andrew] = toHermes3dAgents(backendProfiles);
    expect([def.model, def.provider]).toEqual(["claude-haiku-4-5-20251001", "anthropic"]);
    expect([allan.model, allan.provider]).toEqual(["claude-haiku-4-5-20251001", "claude-cli"]);
    expect([andrew.model, andrew.provider]).toEqual(["gpt-5.6-sol", "openai-codex"]);
  });

  it("routes non-default agents by profile and leaves the default unnamed", async () => {
    const { toHermes3dAgents } = await import("../../server/hermes-agent/bridge");
    const [def, allan] = toHermes3dAgents(backendProfiles);
    // An empty profile means "launch profile" upstream; naming it is wrong.
    expect(def.profile).toBe("");
    expect(allan.profile).toBe("allan");
  });

  it("uses the description after the dash as the role", async () => {
    const { toHermes3dAgents } = await import("../../server/hermes-agent/bridge");
    const allan = toHermes3dAgents(backendProfiles)[1];
    expect(allan.role.startsWith("technical planner")).toBe(true);
  });

  it("picks the flagged profile as the default agent", async () => {
    const { toHermes3dAgents, resolveDefaultAgentId } = await import(
      "../../server/hermes-agent/bridge"
    );
    expect(resolveDefaultAgentId(toHermes3dAgents(backendProfiles))).toBe("default");
  });

  it("ignores unusable rows", async () => {
    const { toHermes3dAgents } = await import("../../server/hermes-agent/bridge");
    expect(toHermes3dAgents([null, {}, "x", { name: "" }])).toEqual([]);
    expect(toHermes3dAgents(undefined)).toEqual([]);
  });

  it("advertises every profile and creates sessions against the right one", async () => {
    const createCalls: Frame[] = [];
    const agent = await startFakeHermesAgent({
      "profiles.list": () => ({ profiles: backendProfiles }),
      "session.create": (params) => {
        createCalls.push(params);
        return { session_id: `rt-${createCalls.length}` };
      },
      "prompt.submit": () => ({}),
    });
    const bridge = await openBridge(agent.url);

    bridge.send({ type: "req", id: "c1", method: "connect", params: {} });
    await bridge.waitFor((f) => f.type === "res" && f.id === "c1", "hello-ok");

    bridge.send({ type: "req", id: "a1", method: "agents.list", params: {} });
    const listed = await bridge.waitFor((f) => f.type === "res" && f.id === "a1", "agents.list");
    expect((at(listed, "payload.agents") as unknown[]).length).toBe(3);

    // A prompt aimed at Allan's desk must run under Allan's profile.
    bridge.send({
      type: "req",
      id: "s1",
      method: "chat.send",
      params: { sessionKey: "agent:allan:main", message: "hi" },
    });
    await bridge.waitFor((f) => f.type === "res" && f.id === "s1", "chat.send");
    expect(createCalls.at(-1)).toEqual({ profile: "allan" });

    // The default agent must NOT send a profile — that means "launch profile".
    bridge.send({
      type: "req",
      id: "s2",
      method: "chat.send",
      params: { sessionKey: "agent:default:main", message: "hi" },
    });
    await bridge.waitFor((f) => f.type === "res" && f.id === "s2", "chat.send default");
    expect(createCalls.at(-1)).toEqual({});
  });

  it("reuses a recent live profile roster across office tabs", async () => {
    let profileLoads = 0;
    const agent = await startFakeHermesAgent({
      "profiles.list": () => {
        profileLoads += 1;
        return { profiles: backendProfiles };
      },
    });
    const first = await openBridge(agent.url);
    const second = await openBridge(agent.url);

    first.send({ type: "req", id: "c1", method: "connect", params: {} });
    second.send({ type: "req", id: "c2", method: "connect", params: {} });

    const [firstHello, secondHello] = await Promise.all([
      first.waitFor((f) => f.type === "res" && f.id === "c1", "first hello-ok"),
      second.waitFor((f) => f.type === "res" && f.id === "c2", "second hello-ok"),
    ]);

    expect(profileLoads).toBe(1);
    expect((at(firstHello, "payload.snapshot.health.agents") as unknown[]).length).toBe(3);
    expect((at(secondHello, "payload.snapshot.health.agents") as unknown[]).length).toBe(3);
  });

  it("a closed single-flight leader does not poison a healthy roster follower", async () => {
    let profileLoads = 0;
    let releaseFirstLoad!: (value: Frame) => void;
    const firstLoad = new Promise<Frame>((resolve) => {
      releaseFirstLoad = resolve;
    });
    const agent = await startFakeHermesAgent({
      "profiles.list": async () => {
        profileLoads += 1;
        if (profileLoads === 1) return firstLoad;
        return { profiles: backendProfiles };
      },
    });
    const leader = await openBridge(agent.url);
    const follower = await openBridge(agent.url);

    leader.send({ type: "req", id: "leader", method: "connect", params: {} });
    while (profileLoads < 1) await new Promise((resolve) => setTimeout(resolve, 5));
    follower.send({ type: "req", id: "follower", method: "connect", params: {} });
    await new Promise((resolve) => setTimeout(resolve, 20));

    leader.upstream.terminate();
    releaseFirstLoad({ profiles: backendProfiles });
    const hello = await follower.waitFor(
      (frame) => frame.type === "res" && frame.id === "follower",
      "healthy follower hello-ok",
    );

    expect(profileLoads).toBe(2);
    expect((at(hello, "payload.snapshot.health.agents") as unknown[]).length).toBe(3);
  });

  it("does not start subscriptions or polling after close during roster loading", async () => {
    let profileLoads = 0;
    let releaseLoad!: (value: Frame) => void;
    const pendingLoad = new Promise<Frame>((resolve) => {
      releaseLoad = resolve;
    });
    const agent = await startFakeHermesAgent({
      "profiles.list": async () => {
        profileLoads += 1;
        return pendingLoad;
      },
    });
    const bridge = await openBridge(agent.url);

    bridge.send({ type: "req", id: "c1", method: "connect", params: {} });
    while (profileLoads < 1) await new Promise((resolve) => setTimeout(resolve, 5));
    bridge.upstream.terminate();
    releaseLoad({ profiles: backendProfiles });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(agent.eventSubscriberCount()).toBe(0);
    expect(agent.boardRequests).toHaveLength(0);
  });

  it("does not publish or serve an in-flight roster invalidated by a model change", async () => {
    let profileLoads = 0;
    let releaseStaleLoad!: (value: Frame) => void;
    const staleLoad = new Promise<Frame>((resolve) => {
      releaseStaleLoad = resolve;
    });
    const updatedProfiles = backendProfiles.map((profile) =>
      profile.name === "allan" ? { ...profile, model: "fresh-model" } : profile,
    );
    const agent = await startFakeHermesAgent({
      "profiles.list": async () => {
        profileLoads += 1;
        if (profileLoads === 1) return { profiles: backendProfiles };
        if (profileLoads === 2) return staleLoad;
        return { profiles: updatedProfiles };
      },
      "profiles.configure": () => ({ ok: true, applied: { model: true } }),
      "session.create": () => ({ session_id: "rt-allan" }),
      "config.set": () => ({ ok: true }),
    });
    const control = await openBridge(agent.url);
    control.send({ type: "req", id: "c1", method: "connect", params: {} });
    await control.waitFor((frame) => frame.type === "res" && frame.id === "c1", "control hello");

    control.send({
      type: "req",
      id: "invalidate-resolved",
      method: "sessions.patch",
      params: { key: "agent:allan:main", model: "anthropic/first-model" },
    });
    await control.waitFor(
      (frame) => frame.type === "res" && frame.id === "invalidate-resolved",
      "first model write",
    );

    const follower = await openBridge(agent.url);
    follower.send({ type: "req", id: "follower", method: "connect", params: {} });
    while (profileLoads < 2) await new Promise((resolve) => setTimeout(resolve, 5));

    control.send({
      type: "req",
      id: "invalidate-flight",
      method: "sessions.patch",
      params: { key: "agent:allan:main", model: "anthropic/fresh-model" },
    });
    await control.waitFor(
      (frame) => frame.type === "res" && frame.id === "invalidate-flight",
      "second model write",
    );
    releaseStaleLoad({ profiles: backendProfiles });

    const hello = await follower.waitFor(
      (frame) => frame.type === "res" && frame.id === "follower",
      "fresh follower hello",
    );
    const agents = at(hello, "payload.snapshot.health.agents") as Array<{
      agentId: string;
      model: string;
    }>;

    expect(profileLoads).toBe(3);
    expect(agents.find((entry) => entry.agentId === "allan")?.model).toBe("fresh-model");
  });

  it("falls back to a single agent when the backend has no profiles.list", async () => {
    const agent = await startFakeHermesAgent({});
    const bridge = await openBridge(agent.url);
    bridge.send({ type: "req", id: "c1", method: "connect", params: {} });
    const res = await bridge.waitFor((f) => f.type === "res" && f.id === "c1", "hello-ok");
    expect((at(res, "payload.snapshot.health.agents") as unknown[]).length).toBe(1);
    expect(at(res, "payload.snapshot.health.defaultAgentId")).toBe("hermes");
  });

  it("carries each profile's model and provider through hello and agents.list", async () => {
    const agent = await startFakeHermesAgent({
      "profiles.list": () => ({ profiles: backendProfiles }),
    });
    const bridge = await openBridge(agent.url);

    bridge.send({ type: "req", id: "c1", method: "connect", params: {} });
    const hello = await bridge.waitFor((f) => f.type === "res" && f.id === "c1", "hello-ok");
    expect(at(hello, "payload.snapshot.health.agents")).toEqual([
      { agentId: "default", name: "Default", isDefault: true, model: "claude-haiku-4-5-20251001", provider: "anthropic" },
      { agentId: "allan", name: "Allan", isDefault: false, model: "claude-haiku-4-5-20251001", provider: "claude-cli" },
      { agentId: "andrew", name: "Andrew", isDefault: false, model: "gpt-5.6-sol", provider: "openai-codex" },
    ]);

    bridge.send({ type: "req", id: "a1", method: "agents.list", params: {} });
    const listed = await bridge.waitFor((f) => f.type === "res" && f.id === "a1", "agents.list");
    const agents = at(listed, "payload.agents") as Record<string, unknown>[];
    expect(agents.map((entry) => [entry.model, entry.provider])).toEqual([
      ["claude-haiku-4-5-20251001", "anthropic"],
      ["claude-haiku-4-5-20251001", "claude-cli"],
      ["gpt-5.6-sol", "openai-codex"],
    ]);
  });

  it("reports the profile's real model on its session rows instead of hermes", async () => {
    const agent = await startFakeHermesAgent({
      "profiles.list": () => ({ profiles: backendProfiles }),
      "session.list": () => ({ sessions: [] }),
    });
    const bridge = await openBridge(agent.url);
    bridge.send({ type: "req", id: "c1", method: "connect", params: {} });
    await bridge.waitFor((f) => f.type === "res" && f.id === "c1", "hello-ok");

    bridge.send({ type: "req", id: "s1", method: "sessions.list", params: {} });
    const res = await bridge.waitFor((f) => f.type === "res" && f.id === "s1", "sessions.list");
    const sessions = at(res, "payload.sessions") as Record<string, unknown>[];
    const allan = sessions.find((entry) => entry.key === "agent:allan:main");

    // The office builds the chat dropdown label from `modelProvider/model`,
    // so a hardcoded "hermes" here is what the desk actually showed.
    expect(allan?.modelProvider).toBe("claude-cli");
    expect(allan?.model).toBe("claude-haiku-4-5-20251001");
    expect((allan?.origin as { provider?: string })?.provider).toBe("claude-cli");
  });
});

describe("toHermes3dCronJobs", () => {
  // Verbatim row shape returned by a live hermes-agent `cron.manage` list.
  const agentJob = {
    job_id: "f43da87997a8",
    name: "Daily token spend - morning briefing",
    prompt_preview: "Run `hermes insights --days 1` and extract today's data.",
    schedule: "0 7 * * *",
    repeat: "forever",
    deliver: "origin",
    next_run_at: "2026-08-19T07:00:00-05:00",
    last_run_at: "2026-08-18T07:00:40.472539-05:00",
    last_status: "ok",
    last_delivery_error: null,
    last_fire_error: null,
    enabled: true,
    state: "scheduled",
  };

  it("fills in the fields the office task board reads unguarded", async () => {
    const { toHermes3dCronJobs } = await import("../../server/hermes-agent/bridge");
    const [job] = toHermes3dCronJobs([agentJob]);

    // These four are exactly what crashed the office page when forwarded raw.
    expect(job.id).toBe("f43da87997a8");
    expect(job.payload).toEqual({ kind: "agentTurn", message: agentJob.prompt_preview });
    expect(job.schedule).toEqual({ kind: "cron", expr: "0 7 * * *" });
    expect(typeof job.state).toBe("object");
    expect(job.state.lastStatus).toBe("ok");
    expect(job.state.nextRunAtMs).toBe(Date.parse(agentJob.next_run_at));
    expect(Number.isFinite(job.updatedAtMs)).toBe(true);
  });

  it("marks a running job so the board can show it as working", async () => {
    const { toHermes3dCronJobs } = await import("../../server/hermes-agent/bridge");
    const [job] = toHermes3dCronJobs([{ ...agentJob, state: "running" }]);
    expect(typeof job.state.runningAtMs).toBe("number");
  });

  it("surfaces a failure so the board can flag it", async () => {
    const { toHermes3dCronJobs } = await import("../../server/hermes-agent/bridge");
    const [job] = toHermes3dCronJobs([
      { ...agentJob, last_status: "error", last_fire_error: "boom" },
    ]);
    expect(job.state.lastStatus).toBe("error");
    expect(job.state.lastError).toBe("boom");
  });

  it("drops rows with no id and tolerates junk", async () => {
    const { toHermes3dCronJobs } = await import("../../server/hermes-agent/bridge");
    expect(toHermes3dCronJobs([{}, null, "nope", { name: "no id" }])).toEqual([]);
    expect(toHermes3dCronJobs(undefined)).toEqual([]);
  });

  it("reads the other schedule spellings hermes-agent emits", async () => {
    const { toHermes3dSchedule } = await import("../../server/hermes-agent/bridge");
    expect(toHermes3dSchedule("30m")).toEqual({ kind: "every", everyMs: 1_800_000 });
    expect(toHermes3dSchedule("every 2h")).toEqual({ kind: "every", everyMs: 7_200_000 });
    expect(toHermes3dSchedule("0 9 * * *")).toEqual({ kind: "cron", expr: "0 9 * * *" });
    expect(toHermes3dSchedule("2026-06-01T09:00:00Z")).toEqual({
      kind: "at",
      at: "2026-06-01T09:00:00Z",
    });
  });
});

describe("toHermes3dMessages", () => {
  it("renames text to content and drops non-conversational rows", () => {
    expect(
      toHermes3dMessages([
        { role: "user", text: "hi" },
        { role: "tool", name: "terminal" },
        { role: "assistant", text: "hello" },
      ]),
    ).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("returns an empty list for a missing transcript", () => {
    expect(toHermes3dMessages(undefined)).toEqual([]);
  });
});

describe("hermes-agent bridge", () => {
  it("sends the token as a query param on /api/ws", async () => {
    const agent = await startFakeHermesAgent({});
    await openBridge(agent.url, "tok-123");

    expect(agent.received.find((frame) => frame.__connect)).toMatchObject({
      path: "/api/ws",
      token: "tok-123",
    });
  });

  it("answers connect with a hello-ok advertising one agent", async () => {
    const agent = await startFakeHermesAgent({});
    const bridge = await openBridge(agent.url);

    bridge.send({ type: "req", id: "c1", method: "connect", params: {} });
    const res = await bridge.waitFor((f) => f.type === "res" && f.id === "c1", "hello-ok");

    expect(res.ok).toBe(true);
    expect(at(res, "payload.type")).toBe("hello-ok");
    expect(at(res, "payload.snapshot.health.agents")).toHaveLength(1);
    expect(at(res, "payload.snapshot.health.defaultAgentId")).toBe("hermes");
  });

  it("turns chat.send into prompt.submit and streams deltas into chat events", async () => {
    const agent = await startFakeHermesAgent({
      "session.create": () => ({ session_id: "s1", stored_session_id: "stored-1" }),
      "prompt.submit": (_params, emit) => {
        setTimeout(() => {
          emit("message.start", {});
          emit("message.delta", { text: "Hel" });
          emit("message.delta", { text: "lo" });
          emit("message.complete", { text: "Hello", status: "complete" });
        }, 10);
        return { status: "streaming" };
      },
    });
    const bridge = await openBridge(agent.url);

    bridge.send({
      type: "req",
      id: "m1",
      method: "chat.send",
      params: { sessionKey: "agent:hermes:main", message: "hi", idempotencyKey: "run-1" },
    });

    const started = await bridge.waitFor((f) => f.type === "res" && f.id === "m1", "chat.send res");
    expect(started.payload).toMatchObject({ status: "started", runId: "run-1" });

    const submitted = agent.received.find((frame) => frame.method === "prompt.submit");
    expect(submitted?.params).toMatchObject({ session_id: "s1", text: "hi" });

    const final = await bridge.waitFor(
      (f) => f.event === "chat" && at(f, "payload.state") === "final",
      "final chat event",
    );
    expect(at(final, "payload.message")).toEqual({ role: "assistant", content: "Hello" });
    expect(at(final, "payload.runId")).toBe("run-1");

    // Deltas accumulate, so the browser always receives the full text so far.
    const deltas = bridge.frames.filter(
      (f) => f.event === "chat" && at(f, "payload.state") === "delta",
    );
    expect(deltas.map((frame) => at(frame, "payload.message.content"))).toEqual(["Hel", "Hello"]);
  });

  it("reports a failed prompt as an error response rather than a silent hang", async () => {
    const agent = await startFakeHermesAgent({
      "session.create": () => ({ session_id: "s1" }),
    });
    const bridge = await openBridge(agent.url);

    bridge.send({
      type: "req",
      id: "m2",
      method: "chat.send",
      params: { sessionKey: "agent:hermes:main", message: "hi" },
    });

    const res = await bridge.waitFor((f) => f.type === "res" && f.id === "m2", "chat.send failure");
    expect(res.ok).toBe(false);
    expect(at(res, "error.code")).toBe("hermes_agent.prompt_failed");
  });

  it("maps chat.abort onto session.interrupt", async () => {
    const agent = await startFakeHermesAgent({
      "session.create": () => ({ session_id: "s1" }),
      "prompt.submit": () => ({ status: "streaming" }),
      "session.interrupt": () => ({ status: "interrupted" }),
    });
    const bridge = await openBridge(agent.url);

    bridge.send({
      type: "req",
      id: "m3",
      method: "chat.send",
      params: { sessionKey: "agent:hermes:main", message: "hi", idempotencyKey: "run-9" },
    });
    await bridge.waitFor((f) => f.type === "res" && f.id === "m3", "chat.send res");

    bridge.send({ type: "req", id: "a1", method: "chat.abort", params: { runId: "run-9" } });
    const res = await bridge.waitFor((f) => f.type === "res" && f.id === "a1", "abort res");

    expect(res.payload).toMatchObject({ ok: true, aborted: 1 });
    expect(agent.received.some((frame) => frame.method === "session.interrupt")).toBe(true);
  });

  it("surfaces stored hermes-agent sessions alongside the main key", async () => {
    const agent = await startFakeHermesAgent({
      "session.list": () => ({
        sessions: [{ id: "20260409_abc", title: "Yesterday's chat", started_at: 1000 }],
      }),
    });
    const bridge = await openBridge(agent.url);

    bridge.send({ type: "req", id: "s1", method: "sessions.list", params: {} });
    const res = await bridge.waitFor((f) => f.type === "res" && f.id === "s1", "sessions.list");

    const sessions = at(res, "payload.sessions") as { key: string }[];
    expect(sessions.map((session) => session.key)).toEqual(
      expect.arrayContaining(["agent:hermes:main", "agent:hermes:20260409_abc"]),
    );
  });

  it("keeps working when an optional upstream method is unavailable", async () => {
    const agent = await startFakeHermesAgent({});
    const bridge = await openBridge(agent.url);

    bridge.send({ type: "req", id: "k1", method: "models.list", params: {} });
    const res = await bridge.waitFor((f) => f.type === "res" && f.id === "k1", "models.list");

    // With no profiles and no catalog there is nothing real to offer; a
    // synthetic "hermes" entry is what made every desk show the wrong model.
    expect(res.ok).toBe(true);
    expect(at(res, "payload.models")).toEqual([]);
  });
});

describe("models.list", () => {
  const backendProfiles = [
    { name: "default", path: "/h", is_default: true, model: "grok-4.6", provider: "xai-oauth" },
    { name: "clody", path: "/h/clody", is_default: false, model: "claude-sonnet-4-6", provider: "claude-cli" },
  ];

  // Verbatim shape of a live hermes-agent `model.options` result.
  const modelOptions = {
    model: "claude-sonnet-4-6",
    provider: "claude-cli",
    providers: [
      { slug: "moa", name: "MoA", models: ["default"], total_models: 1 },
      {
        slug: "anthropic",
        name: "Anthropic",
        models: ["claude-opus-4-5", "claude-sonnet-5"],
        total_models: 2,
      },
      { slug: "openai-codex", name: "OpenAI Codex", models: ["gpt-5.6-sol"], total_models: 1 },
    ],
  };

  it("returns the catalog's real models with their provider", async () => {
    const agent = await startFakeHermesAgent({ "model.options": () => modelOptions });
    const bridge = await openBridge(agent.url);

    bridge.send({ type: "req", id: "k1", method: "models.list", params: {} });
    const res = await bridge.waitFor((f) => f.type === "res" && f.id === "k1", "models.list");
    const models = at(res, "payload.models") as { id: string; name: string; provider: string }[];

    expect(models).toEqual(
      expect.arrayContaining([
        { id: "claude-opus-4-5", name: "claude-opus-4-5 · anthropic", provider: "anthropic" },
        { id: "gpt-5.6-sol", name: "gpt-5.6-sol · openai-codex", provider: "openai-codex" },
      ]),
    );
    expect(models.some((entry) => entry.id === "hermes")).toBe(false);
  });

  it("includes the models the roster actually runs, even outside the catalog", async () => {
    const agent = await startFakeHermesAgent({
      "profiles.list": () => ({ profiles: backendProfiles }),
      "model.options": () => modelOptions,
    });
    const bridge = await openBridge(agent.url);
    bridge.send({ type: "req", id: "c1", method: "connect", params: {} });
    await bridge.waitFor((f) => f.type === "res" && f.id === "c1", "hello-ok");

    bridge.send({ type: "req", id: "k1", method: "models.list", params: {} });
    const res = await bridge.waitFor((f) => f.type === "res" && f.id === "k1", "models.list");
    const models = at(res, "payload.models") as { id: string; provider: string }[];

    // claude-cli serves Clody but never appears in model.options, so without
    // the roster merge Clody's own model is missing from its own dropdown.
    expect(models).toEqual(
      expect.arrayContaining([
        { id: "claude-sonnet-4-6", name: "claude-sonnet-4-6 · claude-cli", provider: "claude-cli" },
        { id: "grok-4.6", name: "grok-4.6 · xai-oauth", provider: "xai-oauth" },
      ]),
    );
    // One row per provider+model pair, no duplicates from the merge.
    const keys = models.map((entry) => `${entry.provider}/${entry.id}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("returns nothing rather than a fake model when the catalog fails", async () => {
    const agent = await startFakeHermesAgent({});
    const bridge = await openBridge(agent.url);

    bridge.send({ type: "req", id: "k1", method: "models.list", params: {} });
    const res = await bridge.waitFor((f) => f.type === "res" && f.id === "k1", "models.list");
    expect(at(res, "payload.models")).toEqual([]);
  });
});

describe("sessions.patch model switch", () => {
  /** A fleet with a named (non-default) profile beside the default one. */
  const fleetProfiles = [
    {
      name: "clody",
      path: "/h/clody",
      is_default: true,
      model: "claude-sonnet-4-6",
      provider: "claude-cli",
    },
    {
      name: "findy",
      path: "/h/findy",
      is_default: false,
      model: "gpt-5-mini",
      provider: "openai",
    },
  ];

  /**
   * Wire a fake backend that records the persistence calls a model switch
   * makes: `profiles.configure` (named profile) and `config.set` (session and
   * root-global writes).
   */
  const startPersistenceAgent = async (overrides: Record<string, RpcHandler> = {}) => {
    const configSets: Frame[] = [];
    const profileConfigures: Frame[] = [];
    const agent = await startFakeHermesAgent({
      "profiles.list": () => ({ profiles: fleetProfiles }),
      "session.create": () => ({ session_id: "rt-1" }),
      "profiles.configure": (params) => {
        profileConfigures.push(params);
        return { ok: true, applied: { model: true } };
      },
      "config.set": (params) => {
        configSets.push(params);
        return {
          key: "model",
          value: String(params.value ?? ""),
          scope: params.session_id ? "session" : "global",
          confirm_required: false,
        };
      },
      ...overrides,
    });
    return { agent, configSets, profileConfigures };
  };

  const connectedBridge = async (url: string) => {
    const bridge = await openBridge(url);
    bridge.send({ type: "req", id: "c1", method: "connect", params: {} });
    await bridge.waitFor((f) => f.type === "res" && f.id === "c1", "hello-ok");
    return bridge;
  };

  it("writes a named profile's default with profiles.configure before touching the session", async () => {
    const { agent, configSets, profileConfigures } = await startPersistenceAgent();
    const bridge = await connectedBridge(agent.url);

    bridge.send({
      type: "req",
      id: "p1",
      method: "sessions.patch",
      params: { key: "agent:findy:main", model: "anthropic/claude-opus-4-5" },
    });
    const res = await bridge.waitFor((f) => f.type === "res" && f.id === "p1", "sessions.patch");

    // The profile default is the durable write; both halves of the pin travel.
    expect(profileConfigures).toEqual([
      { name: "findy", model: "claude-opus-4-5", provider: "anthropic" },
    ]);
    // Then the live session adopts the same model, in hermes-agent's `/model`
    // grammar rather than the office's provider/model key.
    expect(configSets).toEqual([
      {
        key: "model",
        value: "claude-opus-4-5 --provider anthropic",
        session_id: "rt-1",
      },
    ]);
    expect(at(res, "payload.ok")).toBe(true);
    expect(at(res, "payload.resolved")).toEqual({
      model: "claude-opus-4-5",
      modelProvider: "anthropic",
      scope: "profile",
      profile: "findy",
    });

    // The roster now reports the persisted pin, not the stale one.
    bridge.send({ type: "req", id: "a1", method: "agents.list", params: {} });
    const list = await bridge.waitFor((f) => f.type === "res" && f.id === "a1", "agents.list");
    const agents = at(list, "payload.agents") as { id: string; model: string; provider: string }[];
    expect(agents.find((entry) => entry.id === "findy")).toMatchObject({
      model: "claude-opus-4-5",
      provider: "anthropic",
    });
  });

  it("writes the default profile's model with a root --global config.set", async () => {
    const { agent, configSets, profileConfigures } = await startPersistenceAgent();
    const bridge = await connectedBridge(agent.url);

    bridge.send({
      type: "req",
      id: "p1",
      method: "sessions.patch",
      params: { key: "agent:clody:main", model: "anthropic/claude-opus-4-5" },
    });
    const res = await bridge.waitFor((f) => f.type === "res" && f.id === "p1", "sessions.patch");

    // The default profile has no `profiles/default` directory, so its durable
    // write is the root config with `--global` and no session scope.
    expect(profileConfigures).toEqual([]);
    expect(configSets).toEqual([
      { key: "model", value: "claude-opus-4-5 --provider anthropic --global" },
      {
        key: "model",
        value: "claude-opus-4-5 --provider anthropic",
        session_id: "rt-1",
      },
    ]);
    expect(at(res, "payload.resolved")).toEqual({
      model: "claude-opus-4-5",
      modelProvider: "anthropic",
      scope: "profile",
      profile: "clody",
    });
  });

  it("passes a bare model through unchanged and still persists it globally", async () => {
    const configSets: Frame[] = [];
    const agent = await startFakeHermesAgent({
      "session.create": () => ({ session_id: "rt-1" }),
      "config.set": (params) => {
        configSets.push(params);
        return { confirm_required: false };
      },
    });
    const bridge = await openBridge(agent.url);

    bridge.send({
      type: "req",
      id: "p1",
      method: "sessions.patch",
      params: { key: "agent:hermes:main", model: "claude-opus-4-5" },
    });
    const res = await bridge.waitFor((f) => f.type === "res" && f.id === "p1", "sessions.patch");

    expect(configSets).toEqual([
      { key: "model", value: "claude-opus-4-5 --global" },
      { key: "model", value: "claude-opus-4-5", session_id: "rt-1" },
    ]);
    expect(at(res, "payload.resolved.model")).toBe("claude-opus-4-5");
    expect(at(res, "payload.resolved.modelProvider")).toBeUndefined();
  });

  it("fails the patch when a named profile reports the model was not applied", async () => {
    const { agent, configSets } = await startPersistenceAgent({
      "profiles.configure": () => ({ ok: false, applied: { model: false } }),
    });
    const bridge = await connectedBridge(agent.url);

    bridge.send({
      type: "req",
      id: "p1",
      method: "sessions.patch",
      params: { key: "agent:findy:main", model: "anthropic/claude-opus-4-5" },
    });
    const res = await bridge.waitFor((f) => f.type === "res" && f.id === "p1", "sessions.patch");

    expect(at(res, "ok")).toBe(false);
    expect(String(at(res, "error.message"))).toContain("findy");
    // A rejected durable write must not be papered over by a session switch.
    expect(configSets).toEqual([]);

    bridge.send({ type: "req", id: "a1", method: "agents.list", params: {} });
    const list = await bridge.waitFor((f) => f.type === "res" && f.id === "a1", "agents.list");
    const agents = at(list, "payload.agents") as { id: string; model: string }[];
    expect(agents.find((entry) => entry.id === "findy")?.model).toBe("gpt-5-mini");
  });

  it("fails the patch when the global write needs confirmation", async () => {
    const { agent, configSets } = await startPersistenceAgent({
      "config.set": (params) => {
        configSets.push(params);
        return {
          confirm_required: true,
          confirm_message: "claude-opus-4-5 is an expensive model.",
        };
      },
    });
    const bridge = await connectedBridge(agent.url);

    bridge.send({
      type: "req",
      id: "p1",
      method: "sessions.patch",
      params: { key: "agent:clody:main", model: "anthropic/claude-opus-4-5" },
    });
    const res = await bridge.waitFor((f) => f.type === "res" && f.id === "p1", "sessions.patch");

    expect(at(res, "ok")).toBe(false);
    expect(String(at(res, "error.message"))).toContain("expensive model");
    // Only the rejected global write was attempted; no session switch followed.
    expect(configSets).toHaveLength(1);
    expect(configSets[0]).not.toHaveProperty("session_id");
  });

  it("reports a deferred session switch as pending rather than failing", async () => {
    const { agent } = await startPersistenceAgent({
      "config.set": (params) =>
        params.session_id
          ? { key: "model", value: "claude-opus-4-5", scope: "session", deferred: true }
          : { key: "model", value: "claude-opus-4-5", scope: "global", confirm_required: false },
    });
    const bridge = await connectedBridge(agent.url);

    bridge.send({
      type: "req",
      id: "p1",
      method: "sessions.patch",
      params: { key: "agent:clody:main", model: "anthropic/claude-opus-4-5" },
    });
    const res = await bridge.waitFor((f) => f.type === "res" && f.id === "p1", "sessions.patch");

    expect(at(res, "payload.ok")).toBe(true);
    expect(at(res, "payload.resolved.pendingTurn")).toBe(true);
  });

  it("reports the saved default when only the session switch fails", async () => {
    const { agent, profileConfigures } = await startPersistenceAgent({
      "config.set": (params) => {
        if (params.session_id) throw new Error("session switch exploded");
        return { key: "model", value: "claude-opus-4-5", confirm_required: false };
      },
    });
    const bridge = await connectedBridge(agent.url);

    bridge.send({
      type: "req",
      id: "p1",
      method: "sessions.patch",
      params: { key: "agent:findy:main", model: "anthropic/claude-opus-4-5" },
    });
    const res = await bridge.waitFor((f) => f.type === "res" && f.id === "p1", "sessions.patch");

    expect(profileConfigures).toHaveLength(1);
    expect(at(res, "ok")).toBe(false);
    const message = String(at(res, "error.message"));
    // The operator has to know the durable half landed and only the live
    // session is stale, otherwise they retry a write that already happened.
    expect(message).toContain("findy");
    expect(message).toContain("claude-opus-4-5");
  });
});

describe("externally driven activity", () => {
  const fleet = [
    { name: "clody", path: "/h/clody", is_default: true, model: "m", provider: "p" },
    { name: "findy", path: "/h/findy", is_default: false, model: "m", provider: "p" },
  ];

  const startFleetAgent = async (overrides: Record<string, RpcHandler> = {}) =>
    startFakeHermesAgent({
      "profiles.list": () => ({ profiles: fleet }),
      "session.create": () => ({ session_id: "rt-1" }),
      "session.list": () => ({ sessions: [] }),
      ...overrides,
    });

  const connectedBridge = async (url: string) => {
    const bridge = await openBridge(url);
    bridge.send({ type: "req", id: "c1", method: "connect", params: {} });
    await bridge.waitFor((f) => f.type === "res" && f.id === "c1", "hello-ok");
    return bridge;
  };

  const activityFrame = (overrides: Record<string, unknown> = {}) => ({
    v: 1,
    kind: "agent.activity",
    profile: "findy",
    phase: "start",
    sessionId: "ext-1",
    platform: "discord",
    atMs: Date.now(),
    ...overrides,
  });

  const lifecycleFrames = (frames: Frame[]) =>
    frames.filter(
      (frame) => frame.event === "agent" && at(frame, "payload.stream") === "lifecycle",
    );

  const presenceFrames = (frames: Frame[]) => frames.filter((frame) => frame.event === "presence");

  /** Wait until `count` frames match, rather than just the first one. */
  const waitForCount = async (
    bridge: Awaited<ReturnType<typeof openBridge>>,
    predicate: (frame: Frame) => boolean,
    count: number,
    label: string,
  ) => {
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const hits = bridge.frames.filter(predicate);
      if (hits.length >= count) return hits;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(
      `timed out waiting for ${count} x ${label}; saw ${JSON.stringify(bridge.frames)}`,
    );
  };

  const isStart = (frame: Frame) =>
    frame.event === "agent" && at(frame, "payload.data.phase") === "start";

  it("lights up an agent working in another client", async () => {
    const agent = await startFleetAgent();
    const bridge = await connectedBridge(agent.url);

    await agent.publish(activityFrame());
    const event = await bridge.waitFor(
      (frame) => frame.event === "agent" && at(frame, "payload.data.phase") === "start",
      "lifecycle start",
    );

    expect(at(event, "payload.sessionKey")).toBe("agent:findy:main");
    expect(at(event, "payload.runId")).toBeTruthy();
  });

  it("returns the agent to idle when that work ends", async () => {
    const agent = await startFleetAgent();
    const bridge = await connectedBridge(agent.url);

    await agent.publish(activityFrame());
    const started = await bridge.waitFor(
      (frame) => frame.event === "agent" && at(frame, "payload.data.phase") === "start",
      "lifecycle start",
    );
    await agent.publish(activityFrame({ phase: "end" }));
    const ended = await bridge.waitFor(
      (frame) => frame.event === "agent" && at(frame, "payload.data.phase") === "end",
      "lifecycle end",
    );

    // The office ignores a terminal phase for a run it is not tracking, so the
    // two halves have to carry the same run id.
    expect(at(ended, "payload.runId")).toBe(at(started, "payload.runId"));
  });

  it("never puts conversation text on a state frame", async () => {
    const agent = await startFleetAgent();
    const bridge = await connectedBridge(agent.url);

    await agent.publish(activityFrame());
    const event = await bridge.waitFor(
      (frame) => frame.event === "agent" && at(frame, "payload.data.phase") === "start",
      "lifecycle start",
    );

    expect(at(event, "payload.data.text")).toBe("");
    expect(JSON.stringify(event)).not.toContain("discord-message");
  });

  it("ignores a lifecycle frame from a profile this connection does not know", async () => {
    const agent = await startFleetAgent();
    const bridge = await connectedBridge(agent.url);

    await agent.publish(activityFrame({ profile: "stranger" }));
    // A speech frame afterwards proves the subscriber is alive and that the
    // silence above was a decision, not a dropped socket.
    await agent.publish({
      v: 1,
      kind: "agent.turn",
      profile: "findy",
      text: "still here",
      sessionId: "ext-1",
      atMs: Date.now(),
    });
    await bridge.waitFor((frame) => frame.event === "office.speech", "speech");

    expect(lifecycleFrames(bridge.frames)).toEqual([]);
  });

  it("does not restart a character for a second concurrent turn", async () => {
    const agent = await startFleetAgent();
    const bridge = await connectedBridge(agent.url);

    await agent.publish(activityFrame({ sessionId: "ext-1" }));
    await bridge.waitFor(
      (frame) => frame.event === "agent" && at(frame, "payload.data.phase") === "start",
      "first start",
    );
    await agent.publish(activityFrame({ sessionId: "ext-2" }));
    await agent.publish(activityFrame({ sessionId: "ext-1", phase: "end" }));
    // Only the last turn's end may take the character back to idle.
    await agent.publish(activityFrame({ sessionId: "ext-2", phase: "end" }));
    await bridge.waitFor(
      (frame) => frame.event === "agent" && at(frame, "payload.data.phase") === "end",
      "final end",
    );

    expect(
      lifecycleFrames(bridge.frames).map((frame) => at(frame, "payload.data.phase")),
    ).toEqual(["start", "end"]);
  });

  it("leaves a turn Hermes3D is driving to its own lifecycle", async () => {
    const agent = await startFleetAgent({
      "session.create": () => ({ session_id: "rt-local" }),
      "prompt.submit": () => ({ ok: true }),
    });
    const bridge = await connectedBridge(agent.url);

    bridge.send({
      type: "req",
      id: "m1",
      method: "chat.send",
      params: { sessionKey: "agent:findy:main", message: "hi", idempotencyKey: "run-local" },
    });
    await bridge.waitFor((f) => f.type === "res" && f.id === "m1", "chat.send res");

    // The plugin publishes for this turn too — it cannot tell which client
    // asked — so the bridge has to recognise its own run and stay quiet.
    await agent.publish(activityFrame({ sessionId: "rt-local" }));
    await agent.publish({
      v: 1,
      kind: "agent.turn",
      profile: "findy",
      text: "done",
      sessionId: "rt-local",
      atMs: Date.now(),
    });
    await bridge.waitFor((frame) => frame.event === "office.speech", "speech");

    expect(lifecycleFrames(bridge.frames)).toEqual([]);
  });

  /**
   * The office bridge plugin repeats the start frame every few seconds while a
   * direct-profile turn is still running. Those repeats are the only thing
   * standing between the opening frame and the end, so the bridge has to
   * re-emit them: a static summary hydration or a browser reconnect clears the
   * desk mid-turn, and the next heartbeat is what puts the colour back.
   */
  it("re-emits a lifecycle start for a heartbeat of the same session", async () => {
    const agent = await startFleetAgent();
    const bridge = await connectedBridge(agent.url);

    await agent.publish(activityFrame({ sessionId: "ext-1" }));
    await bridge.waitFor(isStart, "first start");
    await agent.publish(activityFrame({ sessionId: "ext-1", atMs: Date.now() }));
    const starts = await waitForCount(bridge, isStart, 2, "heartbeat start");

    // Same visible run, re-asserted: a fresh run id would leave the office
    // tracking a run whose end never matches, so the desk could never clear.
    expect(at(starts[1], "payload.runId")).toBe(at(starts[0], "payload.runId"));
    expect(at(starts[1], "payload.sessionKey")).toBe("agent:findy:main");
  });

  it("keeps the heartbeat frame free of any turn content", async () => {
    const agent = await startFleetAgent();
    const bridge = await connectedBridge(agent.url);

    await agent.publish(
      activityFrame({ sessionId: "ext-1", platform: "discord-message", prompt: "the secret" }),
    );
    await bridge.waitFor(isStart, "first start");
    await agent.publish(
      activityFrame({ sessionId: "ext-1", platform: "discord-message", atMs: Date.now() }),
    );
    const starts = await waitForCount(bridge, isStart, 2, "heartbeat start");

    expect(at(starts[1], "payload.data.text")).toBe("");
    // The run id is a correlation handle and does carry the session id it was
    // minted from; what must never ride along is anything about the work —
    // the prompt, the reply, a task, a path, a token, where it came from.
    const raw = JSON.stringify(at(starts[1], "payload.data"));
    for (const leak of ["discord", "the secret", "prompt", "token"]) {
      expect(raw).not.toContain(leak);
    }
    expect(Object.keys(at(starts[1], "payload.data") as object).sort()).toEqual([
      "phase",
      "source",
      "text",
    ]);
    expect(Object.keys(at(starts[1], "payload") as object).sort()).toEqual([
      "data",
      "runId",
      "sessionKey",
      "stream",
    ]);
  });

  it("ends on the first run id after heartbeats and a second session", async () => {
    const agent = await startFleetAgent();
    const bridge = await connectedBridge(agent.url);

    await agent.publish(activityFrame({ sessionId: "ext-1" }));
    const [started] = await waitForCount(bridge, isStart, 1, "first start");
    // A newly concurrent session must not open a competing visible run...
    await agent.publish(activityFrame({ sessionId: "ext-2", atMs: Date.now() }));
    // ...but its heartbeat still re-asserts the one that is already showing.
    await agent.publish(activityFrame({ sessionId: "ext-2", atMs: Date.now() }));
    const starts = await waitForCount(bridge, isStart, 2, "concurrent heartbeat");
    for (const start of starts) {
      expect(at(start, "payload.runId")).toBe(at(started, "payload.runId"));
    }

    // The first session finishes first; only the last end may clear the desk.
    await agent.publish(activityFrame({ sessionId: "ext-1", phase: "end", atMs: Date.now() }));
    await agent.publish(activityFrame({ sessionId: "ext-2", phase: "end", atMs: Date.now() }));
    const ended = await bridge.waitFor(
      (frame) => frame.event === "agent" && at(frame, "payload.data.phase") === "end",
      "final end",
    );

    expect(at(ended, "payload.runId")).toBe(at(started, "payload.runId"));
    expect(
      lifecycleFrames(bridge.frames).map((frame) => at(frame, "payload.data.phase")),
    ).toEqual(["start", "start", "end"]);
  });

  /**
   * The presence event is what the client turns into a summary refresh, and
   * that static hydration overwrites the live agent state — clearing the desk
   * mid-turn. Synthetic lifecycle is not real session traffic, so it must keep
   * its bookkeeping locally and never publish presence.
   */
  it("does not emit presence for synthetic office activity", async () => {
    const agent = await startFleetAgent();
    const bridge = await connectedBridge(agent.url);

    await agent.publish(activityFrame({ sessionId: "ext-1" }));
    await bridge.waitFor(isStart, "start");
    await agent.publish(activityFrame({ sessionId: "ext-1", phase: "end", atMs: Date.now() }));
    await bridge.waitFor(
      (frame) => frame.event === "agent" && at(frame, "payload.data.phase") === "end",
      "end",
    );

    expect(presenceFrames(bridge.frames)).toEqual([]);
  });

  it("still records the activity locally so sessions.list reports it", async () => {
    const agent = await startFleetAgent();
    const bridge = await connectedBridge(agent.url);

    await agent.publish(activityFrame({ sessionId: "ext-1" }));
    await bridge.waitFor(isStart, "start");

    bridge.send({ type: "req", id: "s1", method: "sessions.list", params: { agentId: "findy" } });
    const res = await bridge.waitFor((f) => f.type === "res" && f.id === "s1", "sessions.list");
    const sessions = (at(res, "payload.sessions") ?? []) as {
      key: string;
      updatedAt: number | null;
    }[];

    const main = sessions.find((session) => session.key === "agent:findy:main");
    expect(typeof main?.updatedAt).toBe("number");
  });
});

describe("kanban worker activity", () => {
  const fleet = [
    { name: "clody", path: "/h/clody", is_default: true, model: "m", provider: "p" },
    { name: "findy", path: "/h/findy", is_default: false, model: "m", provider: "p" },
  ];

  type BoardTask = Record<string, unknown>;

  const runningCard = (overrides: BoardTask = {}): BoardTask => ({
    id: "t_1",
    title: "Rebuild the office activity feed",
    body: "Poll the board and colour the desk.",
    assignee: "findy",
    status: "running",
    workspace_path: "/private/workspace/private",
    ...overrides,
  });

  /** A backend whose board the test can rewrite between polls. */
  const startBoardAgent = async (initial: BoardTask[], status?: number) => {
    let tasks = initial;
    const agent = await startFakeHermesAgent(
      {
        "profiles.list": () => ({ profiles: fleet }),
        "session.create": () => ({ session_id: "rt-1" }),
        "session.list": () => ({ sessions: [] }),
        "prompt.submit": () => ({ ok: true }),
      },
      { board: () => ({ columns: [{ tasks }] }), status },
    );
    return { ...agent, setTasks: (next: BoardTask[]) => (tasks = next) };
  };

  const connectedBridge = async (url: string) => {
    const bridge = await openBridge(url);
    bridge.send({ type: "req", id: "c1", method: "connect", params: {} });
    await bridge.waitFor((f) => f.type === "res" && f.id === "c1", "hello-ok");
    return bridge;
  };

  const lifecycleFrames = (frames: Frame[]) =>
    frames.filter(
      (frame) => frame.event === "agent" && at(frame, "payload.stream") === "lifecycle",
    );

  const waitForPhase = (
    bridge: Awaited<ReturnType<typeof openBridge>>,
    phase: string,
    label: string,
  ) =>
    bridge.waitFor(
      (frame) =>
        frame.event === "agent" &&
        at(frame, "payload.data.source") === "kanban-activity" &&
        at(frame, "payload.data.phase") === phase,
      label,
    );

  /** Long enough that the board poll loop has certainly run once more. */
  const nextPoll = () => new Promise((resolve) => setTimeout(resolve, 2_400));

  it("lights up a worker that was already running when the office connected", async () => {
    const agent = await startBoardAgent([runningCard()]);
    const bridge = await connectedBridge(agent.url);

    const started = await waitForPhase(bridge, "start", "kanban start");
    expect(at(started, "payload.sessionKey")).toBe("agent:findy:main");
    expect(at(started, "payload.runId")).toBeTruthy();
  });

  it("returns the desk to idle once the card leaves running", async () => {
    const agent = await startBoardAgent([runningCard()]);
    const bridge = await connectedBridge(agent.url);

    const started = await waitForPhase(bridge, "start", "kanban start");
    agent.setTasks([runningCard({ status: "done" })]);
    const ended = await waitForPhase(bridge, "end", "kanban end");

    // The office ignores a terminal phase for a run it is not tracking, so
    // both halves have to carry the same run id.
    expect(at(ended, "payload.runId")).toBe(at(started, "payload.runId"));
  });

  it("keeps the desk green while a second card of the same worker runs", async () => {
    const agent = await startBoardAgent([runningCard({ id: "t_1" })]);
    const bridge = await connectedBridge(agent.url);
    await waitForPhase(bridge, "start", "kanban start");

    // Each rewrite gets its own poll, so the tracker really sees the card set
    // grow and shrink rather than jumping straight to an empty board.
    agent.setTasks([runningCard({ id: "t_1" }), runningCard({ id: "t_2" })]);
    await nextPoll();
    agent.setTasks([runningCard({ id: "t_2" })]);
    await nextPoll();
    agent.setTasks([]);
    await waitForPhase(bridge, "end", "kanban end");

    expect(
      lifecycleFrames(bridge.frames).map((frame) => at(frame, "payload.data.phase")),
    ).toEqual(["start", "end"]);
    // Several real poll cycles have to elapse for this to mean anything.
  }, 20_000);

  it("never puts a card's title, body, or workspace on a state frame", async () => {
    const agent = await startBoardAgent([runningCard()]);
    const bridge = await connectedBridge(agent.url);

    const started = await waitForPhase(bridge, "start", "kanban start");
    expect(at(started, "payload.data.text")).toBe("");
    const raw = JSON.stringify(started);
    expect(raw).not.toContain("Rebuild the office activity feed");
    expect(raw).not.toContain("/private/workspace/private");
    expect(raw).not.toContain("t_1");
  });

  it("ignores a card assigned to somebody who is not an agent here", async () => {
    const agent = await startBoardAgent([runningCard({ assignee: "stranger" })]);
    const bridge = await connectedBridge(agent.url);

    // A published turn afterwards proves the bridge is alive and that the
    // silence above was a decision, not a stalled poll.
    await agent.publish({
      v: 1,
      kind: "agent.turn",
      profile: "findy",
      text: "still here",
      sessionId: "ext-1",
      atMs: Date.now(),
    });
    await bridge.waitFor((frame) => frame.event === "office.speech", "speech");

    expect(lifecycleFrames(bridge.frames)).toEqual([]);
  });

  it("holds its silence when the board cannot be read at all", async () => {
    const agent = await startBoardAgent([runningCard()], 500);
    const bridge = await connectedBridge(agent.url);

    await agent.publish({
      v: 1,
      kind: "agent.turn",
      profile: "findy",
      text: "still here",
      sessionId: "ext-1",
      atMs: Date.now(),
    });
    await bridge.waitFor((frame) => frame.event === "office.speech", "speech");

    // A backend with no kanban plugin is not an error state for the office.
    expect(lifecycleFrames(bridge.frames)).toEqual([]);
  });

  it("does not start a competing run for a chat turn already in flight", async () => {
    const agent = await startBoardAgent([]);
    const bridge = await connectedBridge(agent.url);

    bridge.send({
      type: "req",
      id: "m1",
      method: "chat.send",
      params: { sessionKey: "agent:findy:main", message: "hi", idempotencyKey: "run-local" },
    });
    await bridge.waitFor((f) => f.type === "res" && f.id === "m1", "chat.send res");
    agent.setTasks([runningCard()]);

    await agent.publish({
      v: 1,
      kind: "agent.turn",
      profile: "clody",
      text: "still here",
      sessionId: "ext-1",
      atMs: Date.now(),
    });
    await bridge.waitFor((frame) => frame.event === "office.speech", "speech");
    // Give the poll loop a turn to prove it stayed quiet rather than raced.
    await nextPoll();

    expect(lifecycleFrames(bridge.frames)).toEqual([]);
  }, 20_000);

  it("stops polling the board once the connection is torn down", async () => {
    const agent = await startBoardAgent([runningCard()]);
    const bridge = await connectedBridge(agent.url);
    await waitForPhase(bridge, "start", "kanban start");

    bridge.upstream.terminate();
    const seen = agent.boardRequests.length;
    await nextPoll();

    expect(agent.boardRequests.length).toBe(seen);
  }, 20_000);
});

describe("sessions.list scoping", () => {
  const fleet = [
    { name: "clody", path: "/h/clody", is_default: true, model: "m", provider: "p" },
    { name: "findy", path: "/h/findy", is_default: false, model: "m", provider: "p" },
  ];

  const startFleetAgent = async (overrides: Record<string, RpcHandler> = {}) =>
    startFakeHermesAgent({
      "profiles.list": () => ({ profiles: fleet }),
      "session.create": () => ({ session_id: "rt-1" }),
      "session.list": () => ({ sessions: [] }),
      "prompt.submit": () => ({ ok: true }),
      ...overrides,
    });

  const connectedBridge = async (url: string) => {
    const bridge = await openBridge(url);
    bridge.send({ type: "req", id: "c1", method: "connect", params: {} });
    await bridge.waitFor((f) => f.type === "res" && f.id === "c1", "hello-ok");
    return bridge;
  };

  const listSessions = async (
    bridge: Awaited<ReturnType<typeof openBridge>>,
    id: string,
    params: Frame,
  ) => {
    bridge.send({ type: "req", id, method: "sessions.list", params });
    const res = await bridge.waitFor((f) => f.type === "res" && f.id === id, "sessions.list");
    return (at(res, "payload.sessions") ?? []) as { key: string; agentId: string; updatedAt: number | null }[];
  };

  it("answers only for the agent that was asked about", async () => {
    const agent = await startFleetAgent();
    const bridge = await connectedBridge(agent.url);

    const sessions = await listSessions(bridge, "s1", { agentId: "findy" });
    expect(sessions.map((session) => session.agentId)).toEqual(["findy"]);
  });

  it("still lists the whole fleet when no agent is named", async () => {
    const agent = await startFleetAgent();
    const bridge = await connectedBridge(agent.url);

    const sessions = await listSessions(bridge, "s1", {});
    expect(sessions.map((session) => session.agentId)).toEqual(["clody", "findy"]);
  });

  it("returns nothing for an agent this connection does not have", async () => {
    const agent = await startFleetAgent();
    const bridge = await connectedBridge(agent.url);

    expect(await listSessions(bridge, "s1", { agentId: "stranger" })).toEqual([]);
  });

  it("reports no activity for a main session nobody has used", async () => {
    const agent = await startFleetAgent();
    const bridge = await connectedBridge(agent.url);

    const [main] = await listSessions(bridge, "s1", { agentId: "findy" });
    // Stamping `Date.now()` here made every idle desk look like it had just
    // been working, which is the signal the office colours on.
    expect(main.updatedAt).toBeNull();
  });

  it("reports real activity once work actually happens", async () => {
    const agent = await startFleetAgent();
    const bridge = await connectedBridge(agent.url);

    bridge.send({
      type: "req",
      id: "m1",
      method: "chat.send",
      params: { sessionKey: "agent:findy:main", message: "hi", idempotencyKey: "run-1" },
    });
    await bridge.waitFor((f) => f.type === "res" && f.id === "m1", "chat.send res");

    const [main] = await listSessions(bridge, "s1", { agentId: "findy" });
    expect(typeof main.updatedAt).toBe("number");
  });

  it("does not report one agent's work against another", async () => {
    const agent = await startFleetAgent();
    const bridge = await connectedBridge(agent.url);

    bridge.send({
      type: "req",
      id: "m1",
      method: "chat.send",
      params: { sessionKey: "agent:findy:main", message: "hi", idempotencyKey: "run-1" },
    });
    await bridge.waitFor((f) => f.type === "res" && f.id === "m1", "chat.send res");

    const [clodyMain] = await listSessions(bridge, "s1", { agentId: "clody" });
    expect(clodyMain.updatedAt).toBeNull();
  });
});
