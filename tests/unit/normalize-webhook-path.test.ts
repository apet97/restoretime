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

  it("drops a trailing slash so it cannot become a second, unfindable key", () => {
    expect(normalizeWebhookPath("/webhooks/time-entry-deleted/")).toBe(
      "/webhooks/time-entry-deleted",
    );
  });

  it("keeps the root path as a single slash", () => {
    expect(normalizeWebhookPath("/")).toBe("/");
  });

  it("does not read a colon in a relative path as a URL scheme", () => {
    // new URL("webhooks:time-entry-deleted") parses "webhooks" as a scheme and yields the
    // pathname "time-entry-deleted", which would store the token under the wrong key.
    expect(normalizeWebhookPath("webhooks:time-entry-deleted")).toBe(
      "/webhooks:time-entry-deleted",
    );
  });

  it("is idempotent, so writing and looking up agree even across builds", () => {
    for (const input of [
      "//webhooks/time-entry-deleted",
      "/webhooks/time-entry-deleted/",
      "https://example.invalid//webhooks/time-entry-deleted",
      "webhooks/time-entry-deleted",
    ]) {
      const once = normalizeWebhookPath(input);
      expect(normalizeWebhookPath(once)).toBe(once);
    }
  });
});
