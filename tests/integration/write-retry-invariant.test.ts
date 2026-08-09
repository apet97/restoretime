// ADR-007's load-bearing precondition, pinned against the SDK's defaults.
//
// RestoreTime's only Clockify write is `timeEntries.createForUser`. If anything ever retried that
// POST, a customer's timesheet would silently gain a duplicate entry: the first attempt may have
// committed before the response was lost. The whole AMBIGUOUS/reconcile protocol (docs/03 §3,
// docs/07 §8) exists because a write is never retried blind — `executeCreate` classifies and hands
// the decision to a human instead.
//
// `buildClockifyClient` (src/clockify/client.ts) passes no retry configuration, so the invariant
// rests entirely on the SDK's default: mutations are not retried unless a caller opts in
// (`retryMutationMethods`). That is a transitive dependency's default, one `npm i` away from
// changing, and no other test would notice. This one does.
//
// The client is built through `buildClockifyClient`, not `createClockifyClient`, because the claim
// under test is about RestoreTime's configuration of the SDK — same argument as the header of
// `tests/integration/chaos-fetch-drill.test.ts`. The chaos hook stays off; a plain stub is the
// transport.
import { describe, expect, it } from "vitest";
import { ClockifyApiError } from "clockify-sdk-ts-115";
import { buildClockifyClient } from "../../src/clockify/client.js";

const WORKSPACE_ID = "ws-1";
const USER_ID = "user-1";
const START = "2026-08-08T10:00:00Z";

/** Counts every call and answers the createForUser POST with `respond`; anything else is a bug in
 * the test, so it fails loudly rather than resolving. */
function countingTransport(respond: () => Promise<Response>): { fetch: typeof fetch; calls: () => number } {
  let calls = 0;
  const stub: typeof fetch = async (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method !== "POST" || !new URL(raw).pathname.endsWith("/time-entries")) {
      throw new Error(`unexpected request: ${method} ${raw}`);
    }
    calls++;
    return respond();
  };
  return { fetch: stub, calls: () => calls };
}

function createEntry(transport: { fetch: typeof fetch }) {
  const client = buildClockifyClient(
    { apiUrl: "https://developer.clockify.me/api", authToken: "tok" },
    { fetch: transport.fetch },
  );
  return client.timeEntries.createForUser({ workspaceId: WORKSPACE_ID, userId: USER_ID, start: START });
}

describe("the createForUser POST is never retried (ADR-007)", () => {
  it("a 500 is sent once — the response may have been lost after Clockify committed, so a second POST would duplicate the entry", async () => {
    const transport = countingTransport(async () => new Response(JSON.stringify({ message: "boom" }), { status: 500 }));
    await expect(createEntry(transport)).rejects.toBeInstanceOf(ClockifyApiError);
    expect(transport.calls()).toBe(1);
  });

  // `Retry-After: 1` keeps a regression cheap: if this ever starts retrying, the test fails in a
  // second rather than stalling against the 30 s client timeout.
  it("a 429 carrying Retry-After is sent once — the header is an instruction to a retrying client, and this one does not retry writes", async () => {
    const transport = countingTransport(
      async () => new Response(JSON.stringify({ message: "slow down" }), { status: 429, headers: { "retry-after": "1" } }),
    );
    await expect(createEntry(transport)).rejects.toBeInstanceOf(ClockifyApiError);
    expect(transport.calls()).toBe(1);
  });

  it("a rejected transport is sent once — this is the AMBIGUOUS case exactly, where the write may already have landed unseen", async () => {
    const transport = countingTransport(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(createEntry(transport)).rejects.toBeInstanceOf(ClockifyApiError);
    expect(transport.calls()).toBe(1);
  });
});
