import { describe, expect, it } from "vitest";
import { normalizeWebhookPath } from "../../src/platform/installations.js";

describe("normalizeWebhookPath", () => {
  it("passes through an already-normal relative path", () => {
    expect(normalizeWebhookPath("/webhooks/time-entry-deleted")).toBe(
      "/webhooks/time-entry-deleted",
    );
  });

  it("collapses the live-observed double-slash payload", () => {
    // Live finding (2026-08-08, developer environment): Clockify joins baseUrl + "/" + path,
    // which can produce "//webhooks/..." when the stored path already starts with "/".
    expect(normalizeWebhookPath("//webhooks/time-entry-deleted")).toBe(
      "/webhooks/time-entry-deleted",
    );
  });

  it("reduces an absolute URL to its pathname", () => {
    expect(normalizeWebhookPath("https://example.invalid/webhooks/time-entry-deleted")).toBe(
      "/webhooks/time-entry-deleted",
    );
  });

  it("adds a leading slash to a bare relative path", () => {
    expect(normalizeWebhookPath("webhooks/time-entry-deleted")).toBe(
      "/webhooks/time-entry-deleted",
    );
  });
});
