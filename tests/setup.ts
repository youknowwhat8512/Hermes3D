import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";

/**
 * `waitFor` / `findBy*` default to a 1000ms timeout, which assumes a quiet
 * machine. This suite runs ~1425 tests across parallel workers, so a render can
 * legitimately take several seconds under load — one observed failure sat at
 * 5042ms. That produced flaky failures that moved between files run to run
 * (useGatewayConnection, useAgentSettingsMutationController, ...) and scaled
 * with machine load: 1 failure when idle, 8 when busy, and 5 even on an
 * unmodified checkout.
 *
 * The assertions themselves were correct; only the deadline was. A longer
 * timeout does not slow down passing tests — `waitFor` polls and resolves as
 * soon as the condition holds — it only stops a slow-but-correct render from
 * being reported as a failure. Genuine failures still fail, just later.
 */
configure({ asyncUtilTimeout: 15000 });


const ensureLocalStorage = () => {
  if (typeof window === "undefined") return;
  const existing = window.localStorage as unknown as Record<string, unknown> | undefined;
  if (
    existing &&
    typeof existing.getItem === "function" &&
    typeof existing.setItem === "function" &&
    typeof existing.removeItem === "function" &&
    typeof existing.clear === "function"
  ) {
    return;
  }

  const store = new Map<string, string>();
  const storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(String(key)) ? store.get(String(key)) ?? null : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(String(key));
    },
    setItem(key: string, value: string) {
      store.set(String(key), String(value));
    },
  };

  Object.defineProperty(window, "localStorage", {
    value: storage,
    configurable: true,
  });
};

ensureLocalStorage();
