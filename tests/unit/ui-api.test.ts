import { describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient, MutationTransportError } from "../../src/ui/api.js";
import type { TokenAuthority } from "../../src/ui/bridge.js";

const auth: TokenAuthority = {
  getToken: () => "token",
  refresh: vi.fn(),
};

describe("browser API mutation outcomes", () => {
  it("classifies a missing mutation response as unknown", async () => {
    const api = createApiClient(auth, vi.fn().mockRejectedValue(new TypeError("network failed")) as typeof fetch);
    await expect(api.mutate("/api/entries/recreate", {})).rejects.toBeInstanceOf(MutationTransportError);
  });

  it("keeps an HTTP mutation rejection definite", async () => {
    const api = createApiClient(auth, vi.fn().mockResolvedValue(new Response('{"error":"blocked"}', { status: 409 })) as typeof fetch);
    await expect(api.mutate("/api/entries/recreate", {})).rejects.toBeInstanceOf(ApiError);
  });

  it.each([
    new Response(null, { status: 500 }),
    new Response("<html>Bad gateway</html>", { status: 502 }),
    new Response("{not-json", { status: 500 }),
  ])("classifies an unreadable HTTP mutation failure as unknown", async (response) => {
    const api = createApiClient(auth, vi.fn().mockResolvedValue(response) as typeof fetch);
    await expect(api.mutate("/api/entries/recreate", {})).rejects.toBeInstanceOf(MutationTransportError);
  });

  it.each([
    new Response(null, { status: 204 }),
    new Response("not-json", { status: 200 }),
  ])("classifies a successful mutation without a JSON object as unknown", async (response) => {
    const api = createApiClient(auth, vi.fn().mockResolvedValue(response) as typeof fetch);
    await expect(api.mutate("/api/entries/recreate", {})).rejects.toBeInstanceOf(MutationTransportError);
  });

  it("keeps read transport failures retryable", async () => {
    const failure = new TypeError("network failed");
    const api = createApiClient(auth, vi.fn().mockRejectedValue(failure) as typeof fetch);
    await expect(api.get("/api/entries")).rejects.toBe(failure);
  });
});
