// LV-01 (docs/13): "Addon installs on the sacrificial workspace; component loads with verified
// claims; frame-ancestors correct and the sidebar icon (iconPath) renders."
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
// token: that a genuine load renders with the correct `frame-ancestors` header and icon — that is
// the "production smoke" step docs/15 describes separately, and this test says so rather than
// silently standing in for it.
import { describe, expect, it } from "vitest";
import { checkLiveDeployedHost, checkLiveEnv } from "./support.js";

describe("LV-01 install + component boundary (docs/13)", () => {
  it("manifest, icon, static bundle are served; the component route enforces verified claims", async () => {
    const envCheck = checkLiveEnv();
    if (envCheck.blocked) {
      console.log(`LV-01 ${envCheck.reason}`);
      expect(envCheck.blocked).toBe(true);
      return;
    }
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
    console.log("LV-01: manifest/icon/bundle served and /component boundary enforced. A fully authenticated component load is NOT verified here — that needs a browser session (done separately on the developer environment, evidence 'Live run 7').");
  }, 30_000);
});
