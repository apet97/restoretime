import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClockifyBridge } from "@apet97/clockify-addon-sdk/ui";
import { createTokenAuthority } from "../../src/ui/bridge.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("createTokenAuthority", () => {
  it("times out a refresh and accepts a later valid token", async () => {
    vi.useFakeTimers();
    let listener: ((body: unknown) => void) | undefined;
    const unsubscribe = vi.fn();
    const refreshAddonToken = vi.fn();
    const bridge = {
      subscribe: vi.fn((_title: string, callback: (body: unknown) => void) => {
        listener = callback;
        return unsubscribe;
      }),
      refreshAddonToken,
    } as unknown as ClockifyBridge;
    const auth = createTokenAuthority(bridge, "initial-token");

    const timedOut = auth.refresh();
    listener?.({ token: "not-a-string" });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(timedOut).resolves.toBeUndefined();
    expect(auth.getToken()).toBe("initial-token");

    const refreshed = auth.refresh();
    listener?.("new-token");
    await expect(refreshed).resolves.toBe("new-token");
    expect(auth.getToken()).toBe("new-token");

    auth.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(25 * 60 * 1_000);
    expect(refreshAddonToken).toHaveBeenCalledTimes(2);
  });
});
