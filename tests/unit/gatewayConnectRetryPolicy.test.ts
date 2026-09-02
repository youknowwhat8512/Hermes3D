import { describe, expect, it } from "vitest";

import { GatewayResponseError } from "@/lib/gateway/errors";
import {
  isRetryableGatewayConnectError,
  resolveGatewayAutoRetryDelayMs,
} from "@/lib/gateway/GatewayClient";

const baseParams = {
  status: "disconnected" as const,
  didAutoConnect: true,
  hasConnectedOnce: true,
  wasManualDisconnect: false,
  gatewayUrl: "wss://remote.example",
  errorMessage: null as string | null,
  connectErrorCode: null as string | null,
  lastDisconnectCode: null as number | null,
  attempt: 0,
};

describe("resolveGatewayAutoRetryDelayMs", () => {
  it("does not retry when upstream gateway url is missing on Studio host", () => {
    const delay = resolveGatewayAutoRetryDelayMs({
      ...baseParams,
      errorMessage: "Gateway error (studio.gateway_url_missing): Upstream gateway URL is missing.",
      connectErrorCode: "studio.gateway_url_missing",
    });

    expect(delay).toBeNull();
  });

  it("retries when the upstream websocket handshake times out", () => {
    const delay = resolveGatewayAutoRetryDelayMs({
      ...baseParams,
      errorMessage:
        "Gateway error (studio.upstream_timeout): Timed out connecting Studio to the upstream gateway WebSocket.",
      connectErrorCode: "studio.upstream_timeout",
    });

    expect(delay).toBe(2_000);
  });

  it("retries a transient timeout on the first-ever connection", () => {
    const delay = resolveGatewayAutoRetryDelayMs({
      ...baseParams,
      hasConnectedOnce: false,
      errorMessage:
        "Gateway error (studio.upstream_timeout): Timed out connecting Studio to the upstream gateway WebSocket.",
      connectErrorCode: "studio.upstream_timeout",
    });

    expect(delay).toBe(2_000);
  });

  it("retries transient upstream and network failures", () => {
    expect(resolveGatewayAutoRetryDelayMs({
      ...baseParams,
      errorMessage: "Gateway error (studio.upstream_error): upstream reset the connection.",
      connectErrorCode: "studio.upstream_error",
    })).toBe(2_000);

    expect(resolveGatewayAutoRetryDelayMs({
      ...baseParams,
      errorMessage: "WebSocket closed (1011): transient upstream failure",
      lastDisconnectCode: 1011,
    })).toBe(2_000);

    expect(resolveGatewayAutoRetryDelayMs({
      ...baseParams,
      errorMessage: "Network connection lost",
    })).toBe(2_000);
  });

  it("keeps missing or invalid configuration and authorization failures non-retryable", () => {
    for (const connectErrorCode of [
      "studio.gateway_url_missing",
      "studio.gateway_url_invalid",
      "studio.gateway_token_missing",
    ]) {
      expect(resolveGatewayAutoRetryDelayMs({
        ...baseParams,
        connectErrorCode,
      })).toBeNull();
    }

    expect(resolveGatewayAutoRetryDelayMs({
      ...baseParams,
      connectErrorCode: "studio.upstream_rejected",
      errorMessage: "Upstream gateway rejected connect (1008): pairing required.",
    })).toBeNull();
    expect(resolveGatewayAutoRetryDelayMs({
      ...baseParams,
      connectErrorCode: "studio.upstream_error",
      errorMessage: "Forbidden: invalid token",
    })).toBeNull();
  });

  it("does not retry after a manual disconnect", () => {
    expect(resolveGatewayAutoRetryDelayMs({
      ...baseParams,
      wasManualDisconnect: true,
      lastDisconnectCode: 1011,
    })).toBeNull();
  });

  it("does not retry when the upstream gateway explicitly rejects pairing", () => {
    const delay = resolveGatewayAutoRetryDelayMs({
      ...baseParams,
      errorMessage:
        "Gateway error (studio.upstream_rejected): Upstream gateway rejected connect (1008): pairing required.",
      connectErrorCode: "studio.upstream_rejected",
    });

    expect(delay).toBeNull();
  });

  it("classifies transient errors as retryable and auth or configuration errors as terminal", () => {
    expect(isRetryableGatewayConnectError(new GatewayResponseError({
      code: "studio.upstream_timeout",
      message: "upstream timed out",
    }))).toBe(true);
    expect(isRetryableGatewayConnectError(new GatewayResponseError({
      code: "studio.upstream_error",
      message: "network reset",
    }))).toBe(true);
    expect(isRetryableGatewayConnectError(new GatewayResponseError({
      code: "studio.gateway_url_invalid",
      message: "invalid URL",
    }))).toBe(false);
    expect(isRetryableGatewayConnectError(new GatewayResponseError({
      code: "studio.upstream_rejected",
      message: "Forbidden: invalid token",
    }))).toBe(false);
  });

  it("classifies explicit connect policy and configuration errors as terminal", () => {
    const terminalErrors = [
      new GatewayResponseError({
        code: "studio.gateway_url_blocked",
        message: "blocked by allowlist",
      }),
      new GatewayResponseError({
        code: "INVALID_REQUEST",
        message: "origin rejected",
        details: { code: "CONTROL_UI_ORIGIN_NOT_ALLOWED" },
      }),
      new GatewayResponseError({
        code: "INVALID_REQUEST",
        message: "device identity required",
        details: { code: "CONTROL_UI_DEVICE_IDENTITY_REQUIRED" },
      }),
      new GatewayResponseError({
        code: "INVALID_REQUEST",
        message: "invalid config on gateway host",
      }),
      new GatewayResponseError({
        code: "INVALID_REQUEST",
        message: "minProtocol 5 exceeds maxProtocol 4",
      }),
      new GatewayResponseError({
        code: "studio.upstream_rejected",
        message: "upstream policy rejected connect",
      }),
    ];

    for (const error of terminalErrors) {
      expect(isRetryableGatewayConnectError(error)).toBe(false);
      expect(resolveGatewayAutoRetryDelayMs({
        ...baseParams,
        connectErrorCode: error.code,
        errorMessage: error.message,
      })).toBeNull();
    }
  });

  it("keeps explicit transient upstream failures retryable", () => {
    for (const code of [
      "studio.upstream_timeout",
      "studio.upstream_closed",
      "studio.upstream_error",
    ]) {
      const error = new GatewayResponseError({ code, message: "temporary upstream failure" });
      expect(isRetryableGatewayConnectError(error)).toBe(true);
      expect(resolveGatewayAutoRetryDelayMs({
        ...baseParams,
        connectErrorCode: code,
        errorMessage: error.message,
        lastDisconnectCode: code === "studio.upstream_closed" ? 1011 : null,
      })).toBe(2_000);
    }
  });

  it("uses a longer base delay when disconnected by rate limiting (code 1008)", () => {
    const delay = resolveGatewayAutoRetryDelayMs({
      ...baseParams,
      lastDisconnectCode: 1008,
      attempt: 0,
    });

    expect(delay).toBe(15_000);
  });

  it("applies exponential backoff on top of rate-limit base delay", () => {
    const delay = resolveGatewayAutoRetryDelayMs({
      ...baseParams,
      lastDisconnectCode: 1008,
      attempt: 1,
    });

    expect(delay).toBe(22_500);
  });

  it("uses standard base delay for normal disconnects", () => {
    const delay = resolveGatewayAutoRetryDelayMs({
      ...baseParams,
      lastDisconnectCode: 1012,
      attempt: 0,
    });

    expect(delay).toBe(2_000);
  });
});

