// LV-02 (docs/13): "Delete an entry → webhook arrives at the deployed addon → row appears
// (addon-mode delivery already proved on the developer environment 2026-08-08 —
// evidence/install-capture-2026-08-08.md; re-confirm on production)."
//
// Like LV-01, this row is about a REAL Clockify-issued webhook delivered to a REAL deployed host —
// requires `CK_LIVE_ADDON_BASE_URL` (docs/13). What this test CAN do without a live Clockify
// session: perform the real trigger (create then delete a probe entry via `CK_LIVE_API_KEY`) that
// Clockify's platform will fire `TIME_ENTRY_DELETED` for. What it CANNOT do: confirm the row
// actually appeared inside the deployed addon's own database, because reading `/api/entries` on
// the real deployed process requires a component token signed by Clockify's real private key,
// which this suite has no way to mint (see tests/live/support.ts module header and LV-01). This
// test says exactly that rather than claiming a verification it did not perform — receipt
// confirmation is left to the operator (application logs' `webhook_received`/`recoverable_created`
// metric lines, docs/14 "Metrics", or the docs/15 "Production smoke" step).
import { describe, expect, it } from "vitest";
import { ClockifyApiError } from "clockify-sdk-ts-115";
import { buildLiveRestClient, checkLiveDeployedHost, checkLiveEnv, describeIfAuthRejected, RT_PROBE_PREFIX, type LiveEnv } from "./support.js";

describe("LV-02 webhook delivery trigger (docs/13)", () => {
  it("deleting a real entry via CK_LIVE_API_KEY is the trigger side of webhook delivery; receipt at the deployed addon is not verifiable from this suite", async () => {
    const envCheck = checkLiveEnv();
    if (envCheck.blocked) {
      console.log(`LV-02 ${envCheck.reason}`);
      expect(envCheck.blocked).toBe(true);
      return;
    }
    const hostCheck = checkLiveDeployedHost();
    if (hostCheck.blocked) {
      console.log(`LV-02 ${hostCheck.reason}`);
      expect(hostCheck.blocked).toBe(true);
      return;
    }
    const env: LiveEnv = envCheck.env;
    const client = buildLiveRestClient(env);

    // The deployed host must at least be reachable before attributing a missing row to "the
    // webhook never arrived" rather than "the host is down" — LV-01 already covers the full
    // manifest/component checks, this is a minimal liveness precondition.
    const healthz = await fetch(`${hostCheck.addonBaseUrl}/healthz`);
    expect(healthz.status).toBe(200);

    try {
      const users = await client.users.list({ workspaceId: env.workspaceId, status: "ALL", "include-roles": false, "page-size": 200 });
      const active = users.find((u) => u.status === "ACTIVE");
      expect(active, "the sacrificial workspace must have at least one ACTIVE user").toBeDefined();
      if (!active) return;

      const start = new Date(Date.now() - 15 * 60 * 1000);
      const end = new Date(start.getTime() + 5 * 60 * 1000);
      const created = await client.timeEntries.createForUser({
        workspaceId: env.workspaceId,
        userId: active.id,
        start: start.toISOString(),
        end: end.toISOString(),
        description: `${RT_PROBE_PREFIX}LV02 ${start.toISOString()}`,
        billable: false,
      });

      // The delete itself IS the trigger LV-02 exists to fire — Clockify's platform is what
      // decides to deliver TIME_ENTRY_DELETED to every installed addon for this workspace from
      // here; nothing further is this app's responsibility until the webhook route runs.
      await client.timeEntries.delete({ workspaceId: env.workspaceId, timeEntryId: created.id });
      console.log(
        `LV-02: created and deleted a real probe entry (${created.id}) on workspace ${env.workspaceId}. This fires TIME_ENTRY_DELETED at every addon installed there. Confirming the deployed addon at ${hostCheck.addonBaseUrl} actually received and persisted the row requires operator log inspection (docs/14 'webhook_received'/'recoverable_created' metric lines) — not verified by this test.`,
      );
    } catch (err) {
      const rejected = describeIfAuthRejected(err);
      if (rejected) {
        console.log(`LV-02 ${rejected}`);
        throw err;
      }
      if (err instanceof ClockifyApiError) {
        throw new Error(`LV-02: Clockify rejected the probe create/delete (status ${err.statusCode}, code ${JSON.stringify(err.body)}). This is a real live finding, not a suite defect.`, { cause: err });
      }
      throw err;
    }
  }, 30_000);
});
