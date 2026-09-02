import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const browserClients = vi.hoisted(() => ({
  instances: [] as Array<{
    stopped: boolean;
    opts: {
      onHello?: (hello: unknown) => void;
      onClose?: (info: { code: number; reason: string }) => void;
    };
  }>,
}));

vi.mock("@/lib/gateway/protocol/GatewayBrowserClient", () => {
  class GatewayBrowserClient {
    connected = false;
    private readonly instance: (typeof browserClients.instances)[number];

    constructor(opts: (typeof browserClients.instances)[number]["opts"]) {
      this.instance = { opts, stopped: false };
      browserClients.instances.push(this.instance);
    }

    start() {
      this.connected = true;
    }

    stop() {
      this.connected = false;
      this.instance.stopped = true;
    }

    request(method: string) {
      if (method === "config.get") {
        return Promise.resolve({
          config: { gateway: { reload: { mode: "hot" } } },
          hash: "test-hash",
        });
      }
      return Promise.resolve({});
    }
  }

  return {
    GatewayBrowserClient,
    clearGatewayBrowserSessionStorage: () => {},
  };
});

import { useGatewayConnection } from "@/lib/gateway/GatewayClient";

const coordinator = {
  loadSettings: async () => null,
  loadSettingsEnvelope: async () => ({
    settings: {
      version: 1,
      gateway: {
        url: "ws://127.0.0.1:9137",
        token: "",
        adapterType: "hermes-agent" as const,
        lastKnownGood: {
          url: "ws://127.0.0.1:9137",
          adapterType: "hermes-agent" as const,
        },
      },
      focused: {},
      avatars: {},
      analytics: {},
      voiceReplies: {},
      office: {},
      deskAssignments: {},
      standup: {},
      taskBoard: {},
    },
    localGatewayDefaults: null,
  }),
  schedulePatch: vi.fn(),
  flushPending: async () => {},
};

const Probe = () => {
  const state = useGatewayConnection(
    coordinator as unknown as Parameters<typeof useGatewayConnection>[0],
  );
  return createElement(
    "div",
    null,
    createElement("div", { "data-testid": "status" }, state.status),
    createElement("button", { "data-testid": "connect", onClick: () => void state.connect() }, "connect"),
    createElement("button", { "data-testid": "disconnect", onClick: state.disconnect }, "disconnect"),
  );
};

const startFirstAttempt = async () => {
  render(createElement(Probe));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(900);
    await Promise.resolve();
  });
  expect(browserClients.instances).toHaveLength(1);
  return browserClients.instances[0]!;
};

const failTransiently = async (instance: (typeof browserClients.instances)[number]) => {
  await act(async () => {
    instance.opts.onClose?.({ code: 1011, reason: "transient upstream failure" });
    await Promise.resolve();
  });
};

describe("useGatewayConnection retry lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "info").mockImplementation(() => {});
    browserClients.instances = [];
    coordinator.schedulePatch.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("manual disconnect during the inter-attempt delay prevents a second client", async () => {
    const first = await startFirstAttempt();
    await failTransiently(first);

    fireEvent.click(screen.getByTestId("disconnect"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(browserClients.instances).toHaveLength(1);
    expect(screen.getByTestId("status")).toHaveTextContent("disconnected");
  });

  it("unmount during the inter-attempt delay prevents a second client", async () => {
    const first = await startFirstAttempt();
    await failTransiently(first);

    cleanup();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(browserClients.instances).toHaveLength(1);
  });

  it.each([
    ["studio.gateway_url_blocked", "Upstream gateway URL is not in the allowed hosts list."],
    ["studio.gateway_url_invalid", "Upstream gateway URL is invalid."],
    ["studio.gateway_url_missing", "Upstream gateway URL is missing."],
    ["studio.gateway_token_missing", "Upstream gateway token is missing."],
    ["INVALID_REQUEST", "invalid config on gateway host"],
    ["INVALID_REQUEST", "minProtocol 5 exceeds maxProtocol 4"],
    ["INVALID_REQUEST", "control UI origin not allowed"],
    ["INVALID_REQUEST", "control UI device identity required"],
  ])("does not automatically retry transported terminal error %s: %s", async (code, message) => {
    const first = await startFirstAttempt();
    await act(async () => {
      first.opts.onClose?.({
        code: 4008,
        reason: `connect failed: ${code} ${message}`,
      });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(browserClients.instances).toHaveLength(1);
    expect(screen.getByTestId("status")).toHaveTextContent("disconnected");
  });

  it("allows a later explicit connect after cancelling an inter-attempt delay", async () => {
    const first = await startFirstAttempt();
    await failTransiently(first);
    fireEvent.click(screen.getByTestId("disconnect"));

    fireEvent.click(screen.getByTestId("connect"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(browserClients.instances).toHaveLength(2);

    const explicit = browserClients.instances[1]!;
    await act(async () => {
      explicit.opts.onHello?.({ type: "hello-ok", protocol: 3, adapterType: "hermes-agent" });
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(browserClients.instances).toHaveLength(2);
    expect(screen.getByTestId("status")).toHaveTextContent("connected");
  });

  it("a transient first failure reaches a successful subsequent connection", async () => {
    const first = await startFirstAttempt();
    await failTransiently(first);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_200);
    });
    expect(browserClients.instances).toHaveLength(2);

    const second = browserClients.instances[1]!;
    await act(async () => {
      second.opts.onHello?.({ type: "hello-ok", protocol: 3, adapterType: "hermes-agent" });
      await Promise.resolve();
    });

    expect(screen.getByTestId("status")).toHaveTextContent("connected");
    expect(first.stopped).toBe(true);
  });
});
