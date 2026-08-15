// LV-01 is split into two honest claims (docs/13). LV-01A automates target identity, deployed-host
// assets, and the unauthenticated component boundary. LV-01B consumes an operator receipt for the
// Clockify-signed iframe render, sidebar icon, loaded deleted-entry list, CSP, and browser-error
// checks that this process cannot create itself.
//
// This row needs a REAL Clockify-issued installation and a REAL Clockify-signed component session
// — neither can be produced by this suite's test-signed local harness (see tests/live/support.ts
// module header), so it requires `CK_LIVE_ADDON_BASE_URL`: the public base URL of a RestoreTime
// instance that is already deployed AND already installed on the sacrificial workspace (an
// operator action, per docs/15 release pipeline steps 2-3). Without it, this row reports blocked —
// it is never satisfied by the in-process harness the other LV rows use.
//
// What this test CAN prove without a live Clockify session (all real HTTP against the deployed
// host): the manifest is well-formed and reviewable (docs/15 "Marketplace submission
// prerequisites"), the icon and UI bundle are served, and the `/component` route actually enforces
// the verified-claims boundary (401 without a token) rather than being open or crashing. What it
// CANNOT prove without a human (or Clockify-side) browser session holding a real signed component
// token: that a genuine developer load renders the working list with the correct icon, CSP, and
// browser-error state. The candidate-bound LV-01B operator receipt proves that developer boundary.
// A later production check remains a separate gap.
import { describe, expect, it } from "vitest";
import {
  assertLiveTargetIdentity,
  checkLiveDeployedHost,
  checkLiveEnv,
  checkLiveReceipt,
} from "./support.js";

describe("LV-01 deployed component evidence (docs/13)", () => {
  it("LV-01A: target identity, manifest, icon, bundle, and unauthenticated component boundary", async () => {
    const envCheck = checkLiveEnv();
    if (envCheck.blocked) {
      console.log(`LV-01 ${envCheck.reason}`);
      expect(envCheck.blocked).toBe(true);
      return;
    }
    const identity = await assertLiveTargetIdentity(envCheck.env);
    const hostCheck = checkLiveDeployedHost();
    if (hostCheck.blocked) {
      console.log(`LV-01 ${hostCheck.reason}`);
      expect(hostCheck.blocked).toBe(true);
      return;
    }
    const base = hostCheck.addonBaseUrl;

    const healthz = await fetch(`${base}/healthz`);
    expect(healthz.status).toBe(200);
    const healthzBody = (await healthz.json()) as { status: string; db: string };
    expect(healthzBody).toEqual({ status: "ok", db: "ok" });

    const manifestResponse = await fetch(`${base}/manifest`);
    expect(manifestResponse.status).toBe(200);
    const manifest = (await manifestResponse.json()) as {
      key?: string;
      baseUrl?: string;
      iconPath?: string;
      scopes?: string[];
    };
    expect(manifest.key).toBe(envCheck.env.addonKey);
    expect(manifest.iconPath).toBe("/icon.svg");
    expect(manifest.baseUrl).toBe(base);
    const requiredScopes = [
      "TIME_ENTRY_READ",
      "TIME_ENTRY_WRITE",
      "PROJECT_READ",
      "TASK_READ",
      "TAG_READ",
      "USER_READ",
      "CUSTOM_FIELDS_READ",
      "WORKSPACE_READ",
    ];
    for (const scope of requiredScopes) expect(manifest.scopes).toContain(scope);

    const icon = await fetch(`${base}/icon.svg`);
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toMatch(/svg/);
    const iconBody = await icon.text();
    expect(iconBody.length).toBeGreaterThan(0);

    const bundle = await fetch(`${base}/static/app.js`);
    expect(bundle.status).toBe(200);
    const bundleBody = await bundle.text();
    expect(bundleBody.length).toBeGreaterThan(0);

    // No token: proves the verified-claims boundary is wired on the deployed process (not just
    // offline). An authenticated load still needs a genuine Clockify-signed session and stays out
    // of this suite's reach; it was done by hand in a real iframe instead (evidence
    // "Live run 7"), which is what caught the missing `connect-src` this suite could not see.
    const component = await fetch(`${base}/component`);
    expect(component.status).toBe(401);
    console.log(`LV-01A: verified developer target ${identity.workspaceName} (${envCheck.env.workspaceId}), manifest identity, assets, and the unauthenticated /component boundary.`);
  }, 30_000);

  it("LV-01B: operator receipt confirms the authenticated working iframe and clean browser checks", () => {
    const envCheck = checkLiveEnv();
    if (envCheck.blocked) {
      console.log(`LV-01B ${envCheck.reason}`);
      expect(envCheck.blocked).toBe(true);
      return;
    }
    const hostCheck = checkLiveDeployedHost();
    if (hostCheck.blocked) {
      console.log(`LV-01B ${hostCheck.reason}`);
      expect(hostCheck.blocked).toBe(true);
      return;
    }
    const receipt = checkLiveReceipt({ row: "LV-01B", env: envCheck.env, addonBaseUrl: hostCheck.addonBaseUrl });
    if (receipt.blocked) {
      console.log(`LV-01B ${receipt.reason}`);
      expect(receipt.blocked).toBe(true);
      return;
    }
    expect(receipt.receipt.authenticatedComponentRendered).toBe(true);
    expect(receipt.receipt.deletedEntryListLoaded).toBe(true);
    expect(receipt.receipt.contentSecurityPolicyVerified).toBe(true);
    expect(receipt.receipt.appConsoleErrorCount).toBe(0);
    expect(receipt.receipt.cspErrorCount).toBe(0);
  });
});
