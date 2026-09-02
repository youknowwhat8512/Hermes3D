// @vitest-environment node
/**
 * End-to-end proof of the bug this work exists to fix.
 *
 * The office bridge plugin brackets model inference only: `pre_llm_call` opens
 * a turn and `post_llm_call` closes it. A kanban worker spends most of its run
 * *outside* that bracket — running tools, writing files, executing tests — so
 * the desk went grey while the card was still at raw `running` with a live
 * heartbeat. Polling the board fixes the plain case, but the interesting case
 * is the overlap: inference finishing mid-task must not idle a desk whose card
 * is still running, and the board must not fight a lifecycle that already owns
 * the desk.
 *
 * This drives the real bridge against a fake backend that serves both the
 * JSON-RPC gateway and the kanban board, so the assertions are about frames
 * actually put on the wire.
 */
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const { createHermesAgentUpstream } = await import("../../server/hermes-agent/bridge");
const { buildKanbanRunId } = await import("../../server/hermes-agent/kanban-activity");

type Frame = Record<string, unknown>;
type BoardTask = Record<string, unknown>;

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

const fleet = [
  { name: "clody", path: "/h/clody", is_default: true, model: "m", provider: "p" },
  { name: "findy", path: "/h/findy", is_default: false, model: "m", provider: "p" },
];

/** A backend serving the gateway plus a board the test can rewrite. */
const startBackend = async (initial: BoardTask[]) => {
  let tasks = initial;
  const httpServer = createServer((req, res) => {
    if (!String(req.url ?? "").startsWith("/api/plugins/kanban/board")) {
      res.writeHead(404).end("{}");
      return;
    }
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ columns: [{ tasks }] }));
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

  const handlers: Record<string, (params: Frame) => Frame> = {
    "profiles.list": () => ({ profiles: fleet }),
    "session.create": () => ({ session_id: "rt-local" }),
    "session.list": () => ({ sessions: [] }),
    "prompt.submit": () => ({ ok: true }),
  };

  const eventSubscribers: WsSocket[] = [];
  let emitEvent: ((type: string, payload: Frame) => void) | null = null;

  wss.on("connection", (ws: WsSocket, req) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api/events") {
      eventSubscribers.push(ws);
      return;
    }
    const send = (obj: unknown) => ws.send(JSON.stringify(obj));
    emitEvent = (type, payload) =>
      send({ jsonrpc: "2.0", method: "event", params: { type, session_id: "rt-local", payload } });
    send({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: {} } });
    ws.on("message", (raw) => {
      const request = JSON.parse(String(raw)) as Frame;
      const handler = handlers[String(request.method)];
      send({ jsonrpc: "2.0", id: request.id, result: handler ? handler(request) : {} });
    });
  });

  const publish = async (frame: Record<string, unknown>) => {
    const start = Date.now();
    while (eventSubscribers.length === 0 && Date.now() - start < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    eventSubscribers[eventSubscribers.length - 1]?.send(JSON.stringify(frame));
  };

  const { port } = wss.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}`,
    publish,
    setTasks: (next: BoardTask[]) => (tasks = next),
    completeRun: () => emitEvent?.("message.complete", { text: "done", status: "ok" }),
  };
};

const openBridge = async (url: string) => {
  const frames: Frame[] = [];
  const upstream = createHermesAgentUpstream({ url, token: "" });
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
    while (Date.now() - start < 8000) {
      const hit = frames.find(predicate);
      if (hit) return hit;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  send({ type: "req", id: "c1", method: "connect", params: {} });
  await waitFor((f) => f.type === "res" && f.id === "c1", "hello-ok");
  return { upstream, frames, send, waitFor };
};

const runningCard = (overrides: BoardTask = {}): BoardTask => ({
  id: "t_53b4e914",
  title: "Reproduce and fix the polling bug",
  body: "Run the tests.",
  assignee: "clody",
  status: "running",
  workspace_path: "/private/workspace/private",
  ...overrides,
});

const kanbanLifecycle = (frames: Frame[]) =>
  frames.filter(
    (frame) =>
      frame.event === "agent" && at(frame, "payload.data.source") === "kanban-activity",
  );

/** Every lifecycle frame, whatever lit it — the desk only has one colour. */
const allLifecycle = (frames: Frame[]) =>
  frames.filter(
    (frame) => frame.event === "agent" && at(frame, "payload.stream") === "lifecycle",
  );

/** Comfortably longer than one 2s board poll. */
const nextPoll = () => new Promise((resolve) => setTimeout(resolve, 2_400));

describe("kanban activity coexisting with inference activity", () => {
  it(
    "keeps the desk green when inference ends but the card is still running",
    async () => {
      const backend = await startBackend([runningCard()]);
      const bridge = await openBridge(backend.url);

      // The board lights the desk: this is the worker's long tool phase.
      const started = await bridge.waitFor(
        (f) => f.event === "agent" && at(f, "payload.data.phase") === "start",
        "kanban start",
      );
      expect(at(started, "payload.runId")).toBe(buildKanbanRunId("clody"));

      // A model call happens inside that same task. The plugin brackets it and
      // publishes its own lifecycle, which the office applies over the top —
      // so the desk is now tracking the plugin's run, not the board's.
      await backend.publish({
        v: 1,
        kind: "agent.activity",
        profile: "clody",
        phase: "start",
        sessionId: "ext-1",
        atMs: Date.now(),
      });
      await bridge.waitFor(
        (f) =>
          f.event === "agent" &&
          at(f, "payload.data.source") === "office-activity" &&
          at(f, "payload.data.phase") === "start",
        "inference start",
      );
      // Let a full poll observe that the desk is busy, exactly as it would in
      // a real run where inference lasts longer than the poll interval.
      await nextPoll();

      // Inference finishes while the card keeps running. On its own this end
      // takes the desk to idle — the regression this whole feature exists to
      // stop, reappearing from the plugin side.
      await backend.publish({
        v: 1,
        kind: "agent.activity",
        profile: "clody",
        phase: "end",
        sessionId: "ext-1",
        atMs: Date.now(),
      });
      await bridge.waitFor(
        (f) =>
          f.event === "agent" &&
          at(f, "payload.data.source") === "office-activity" &&
          at(f, "payload.data.phase") === "end",
        "inference end",
      );
      await nextPoll();

      // The board has to take the desk straight back, with its own run id, or
      // the worker grinds on for minutes behind a grey character.
      const frames = allLifecycle(bridge.frames);
      const last = frames[frames.length - 1];
      expect(at(last, "payload.data.source")).toBe("kanban-activity");
      expect(at(last, "payload.data.phase")).toBe("start");
      expect(at(last, "payload.runId")).toBe(buildKanbanRunId("clody"));
    },
    30_000,
  );

  it(
    "returns the desk to idle only once the card itself leaves running",
    async () => {
      const backend = await startBackend([runningCard()]);
      const bridge = await openBridge(backend.url);
      await bridge.waitFor(
        (f) => f.event === "agent" && at(f, "payload.data.phase") === "start",
        "kanban start",
      );

      backend.setTasks([runningCard({ status: "done" })]);
      const ended = await bridge.waitFor(
        (f) =>
          f.event === "agent" &&
          at(f, "payload.data.source") === "kanban-activity" &&
          at(f, "payload.data.phase") === "end",
        "kanban end",
      );
      // Same deterministic run id, or the office ignores the terminal phase.
      expect(at(ended, "payload.runId")).toBe(buildKanbanRunId("clody"));
    },
    30_000,
  );

  it(
    "never leaks card content on any frame it emits",
    async () => {
      const backend = await startBackend([runningCard()]);
      const bridge = await openBridge(backend.url);
      await bridge.waitFor(
        (f) => f.event === "agent" && at(f, "payload.data.phase") === "start",
        "kanban start",
      );
      backend.setTasks([]);
      await bridge.waitFor(
        (f) =>
          f.event === "agent" &&
          at(f, "payload.data.source") === "kanban-activity" &&
          at(f, "payload.data.phase") === "end",
        "kanban end",
      );

      const raw = JSON.stringify(kanbanLifecycle(bridge.frames));
      for (const secret of [
        "Reproduce and fix the polling bug",
        "Run the tests.",
        "/private/workspace/private",
        "t_53b4e914",
      ]) {
        expect(raw).not.toContain(secret);
      }
    },
    30_000,
  );
});
