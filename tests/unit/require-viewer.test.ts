import { describe, expect, it } from "vitest";
import type { AddonRequest } from "@apet97/clockify-addon-sdk";
import type { ClockifySignatureParser } from "@apet97/clockify-addon-sdk/clockify";
import { generateTestKeys, signTestToken } from "@apet97/clockify-addon-sdk/testing";
import { requireViewer } from "../../src/platform/verify.js";

const ADDON_KEY = "restoretime-test";

function request(headers: AddonRequest["headers"] = {}): AddonRequest {
  return { method: "GET", path: "/api/ping", headers };
}

describe("requireViewer", () => {
  it(
    "rejects a token whose claims have no exp — proves requireExpiration:true is passed " +
      "(verifyClockifyToken defaults it to false; deleting the option from requireViewer " +
      "would turn this 401 into a 200)",
    async () => {
      const claimsWithoutExp = {
        type: "addon",
        iss: "clockify",
        sub: ADDON_KEY,
        user: "user-1",
        workspaceId: "ws-1",
        workspaceRole: "admin",
      };
      // A minimal test double, not a real signature parser — casting past the SDK class's
      // private fields is the standard way to stub it (DEPENDENCIES.md forbids importing jose
      // directly, which a real exp-less signed token would otherwise require).
      const stubParser = {
        parseClaims: async () => claimsWithoutExp,
      } as unknown as ClockifySignatureParser;

      const handler = requireViewer(stubParser, async (_req, viewer) => ({
        status: 200,
        body: viewer,
      }));

      const response = await handler(request({ authorization: "Bearer anything" }));
      expect(response.status).toBe(401);
    },
  );

  it("accepts a real, non-expired, correctly-shaped token", async () => {
    const keys = await generateTestKeys();
    const { createClockifySignatureParser } = await import("@apet97/clockify-addon-sdk/clockify");
    const parser = createClockifySignatureParser(ADDON_KEY, { publicKey: keys.publicKey });
    const token = await signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: "ws-1",
      addonId: "addon-1",
      user: "user-1",
      workspaceRole: "admin",
    });

    const handler = requireViewer(parser, async (_req, viewer) => ({ status: 200, body: viewer }));
    const response = await handler(request({ authorization: `Bearer ${token}` }));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ userId: "user-1", workspaceId: "ws-1", workspaceRole: "admin" });
  });

  it("rejects a missing Authorization header", async () => {
    const keys = await generateTestKeys();
    const { createClockifySignatureParser } = await import("@apet97/clockify-addon-sdk/clockify");
    const parser = createClockifySignatureParser(ADDON_KEY, { publicKey: keys.publicKey });
    const handler = requireViewer(parser, async (_req, viewer) => ({ status: 200, body: viewer }));

    const response = await handler(request({}));
    expect(response.status).toBe(401);
  });

  it("rejects a header that is not a Bearer token", async () => {
    const keys = await generateTestKeys();
    const { createClockifySignatureParser } = await import("@apet97/clockify-addon-sdk/clockify");
    const parser = createClockifySignatureParser(ADDON_KEY, { publicKey: keys.publicKey });
    const handler = requireViewer(parser, async (_req, viewer) => ({ status: 200, body: viewer }));

    const response = await handler(request({ authorization: "Basic dXNlcjpwYXNz" }));
    expect(response.status).toBe(401);
  });

  it("rejects an expired token", async () => {
    const keys = await generateTestKeys();
    const { createClockifySignatureParser } = await import("@apet97/clockify-addon-sdk/clockify");
    const parser = createClockifySignatureParser(ADDON_KEY, { publicKey: keys.publicKey });
    const token = await signTestToken(
      keys.privateKey,
      ADDON_KEY,
      { workspaceId: "ws-1", addonId: "addon-1", user: "user-1", workspaceRole: "admin" },
      "-10s",
    );

    const handler = requireViewer(parser, async (_req, viewer) => ({ status: 200, body: viewer }));
    const response = await handler(request({ authorization: `Bearer ${token}` }));
    expect(response.status).toBe(401);
  });
});
