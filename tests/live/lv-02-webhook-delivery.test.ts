// LV-02B is the release assertion. The separate `lv-02-webhook-trigger.test.ts` file creates the
// LV-02A trigger and is excluded from diagnostic and release collection. This test requires the
// exact printed source ID and rejects a receipt for any other trigger or candidate.
//
// Like LV-01, this row is about a REAL Clockify-issued webhook delivered to a REAL deployed host —
// requires `CK_LIVE_ADDON_BASE_URL` (docs/13). This strict row does not create another trigger.
// It validates an operator receipt for the source ID from the separate LV-02A command. That
// receipt must correlate the Railway webhook logs and direct remote-SQLite inspection. The suite
// cannot mint Clockify's real component token or read the remote volume itself.
import { describe, expect, it } from "vitest";
import {
  checkLiveDeployedHost,
  checkLiveEnv,
  checkLiveReceipt,
} from "./support.js";

describe("LV-02 deployed webhook evidence (docs/13)", () => {
  it("LV-02B: operator receipt confirms webhook receipt and row creation for the named trigger", () => {
    const envCheck = checkLiveEnv();
    if (envCheck.blocked) {
      console.log(`LV-02B ${envCheck.reason}`);
      expect(envCheck.blocked).toBe(true);
      return;
    }
    const hostCheck = checkLiveDeployedHost();
    if (hostCheck.blocked) {
      console.log(`LV-02B ${hostCheck.reason}`);
      expect(hostCheck.blocked).toBe(true);
      return;
    }
    const receipt = checkLiveReceipt({ row: "LV-02B", env: envCheck.env, addonBaseUrl: hostCheck.addonBaseUrl });
    if (receipt.blocked) {
      console.log(`LV-02B ${receipt.reason}`);
      expect(receipt.blocked).toBe(true);
      return;
    }
    expect(receipt.receipt.railwayWebhookLogCorrelated).toBe(true);
    expect(receipt.receipt.remoteSqliteRowPresent).toBe(true);
  });
});
