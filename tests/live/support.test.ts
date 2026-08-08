// Proves the `recordingPassthroughFetch` seam (tests/live/support.ts, used by LV-09) works
// correctly when installed as `globalThis.fetch` — the exact way LV-09 installs it. Needs no
// credential and always runs: this is a mechanism proof, not a live scenario, so it belongs beside
// the helper it tests rather than under any LV-NN row.
//
// The bug this guards against: capturing "the real fetch" as the bare `fetch` identifier INSIDE
// the wrapper's own closure resolves through the global object at CALL TIME — by the time the
// wrapper is installed as `globalThis.fetch` and invoked, that identifier IS the wrapper itself,
// so every call recurses into itself and blows the stack on the very first request. The fix
// (`REAL_FETCH` captured once at module load, before any stubbing) is proved here by installing
// the wrapper and driving one real request through it against a closed local port: a fast,
// deterministic connection failure (ECONNREFUSED-shaped) is the expected outcome; a
// `RangeError: Maximum call stack size exceeded` would be the regression.
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordingPassthroughFetch } from "./support.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("recordingPassthroughFetch (tests/live/support.ts)", () => {
  it("records the call and forwards to the REAL network fetch, not back into itself, once installed as globalThis.fetch", async () => {
    const recorded: { method: string; url: string }[] = [];
    vi.stubGlobal("fetch", recordingPassthroughFetch(recorded));

    // Port 1 is a closed, unprivileged-unreachable port on loopback: undici's fetch rejects with a
    // connection-refused-style error quickly and deterministically. A stack overflow would throw a
    // RangeError instead — an entirely different, easily distinguished failure shape.
    let caught: unknown;
    try {
      await fetch("http://127.0.0.1:1/");
      expect.unreachable("a request to a closed port must reject");
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeInstanceOf(RangeError);
    expect(String(caught)).not.toMatch(/Maximum call stack size exceeded/);

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.method).toBe("GET");
    expect(recorded[0]?.url).toBe("http://127.0.0.1:1/");
  }, 10_000);
});
