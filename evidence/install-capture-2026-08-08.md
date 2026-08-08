# Install capture — 2026-08-08 (developer environment)

Live installation of the final RestoreTime manifest on Clockify's **developer environment**,
via a cloudflared quick tunnel to the local capture server
(`tools/install-capture/`). This closes the two largest NOT_TESTABLE evidence gaps before
implementation: the addon-token REST success path (R11) and addon-mode webhook delivery (W11).

## Setup

- Capture server: `tools/install-capture/server.mjs` (Node, addon SDK 1.2.0 from npm; dev tool,
  superseded by PASS-01). Installation records stored encrypted (SDK AES-GCM codec,
  `var/key.hex` 0600, `var/installations.json` 0600, both gitignored).
- Tunnel: `cloudflared tunnel --url http://127.0.0.1:8791` → quick-tunnel URL
  `https://brooks-societies-rebate-engaged.trycloudflare.com`. The manifest `baseUrl` equals the
  tunnel URL; the URL lives only while the tunnel process runs.
- Manifest: the FINAL product shape (key `restoretime`, schema 1.5, FREE plan, 8 scopes,
  sidebar component with icon, one `TIME_ENTRY_DELETED` webhook, three lifecycle hooks). No
  reinstall is needed when the product ships.

## Facts

| # | Fact | Confidence |
|---|---|---|
| IC-1 | The developer environment (`developer.clockify.me`) verified the INSTALLED lifecycle JWT with the SDK's pinned platform key — `createClockifySignatureParser(addonKey)` defaults worked; no key override needed | PROVED |
| IC-2 | Captured installation: workspace `69bda6b317a0c5babe34b4ff`, addonId `6a76834a2a539b0829b7a5ae`, `apiUrl` `https://developer.clockify.me/api` → `resolveClockifyApiBaseUrl` → `https://developer.clockify.me/api/v1` (matches the operator's note) | PROVED |
| IC-3 | The INSTALLED payload carried the webhook path as `//webhooks/time-entry-deleted` (double leading slash — Clockify joins `baseUrl` + "/" + manifest path). Token storage/lookup must normalize paths. → docs/01 W17, docs/03 §1, docs/04, PASS-02 | PROVED |
| IC-4 | **R11 addon-token success path PROVED**: with the captured addon token, `users.list` (10 users, all ACTIVE), `projects.list` (36 projects), `timeEntries.createForUser` **for another user** (a second ACTIVE workspace member, id withheld — ≠ the installer) → **201** with the target `userId`, `timeEntries.get`, `timeEntries.delete` all succeeded (probe `tools/install-capture/probe-addon-token.mjs`) | PROVED |
| IC-5 | **W11 addon-mode delivery PROVED**: deleting the probe entry fired `TIME_ENTRY_DELETED` to the manifest-declared path through the tunnel; the SDK RS256 + per-installation-token verification passed; the payload matched the contract (flat entry, embedded project, owner `userId`, type `REGULAR`, `currentlyRunning: false`, `body.workspaceId === claims.workspaceId`) | PROVED |
| IC-6 | A create without `projectId` in this workspace → 400 body code `501` ("Project is either required field or given project is archived…") — re-confirms R4/R15 (forceProjects) on the developer environment; codes compare as strings | PROVED |
| IC-7 | The component route without a token → 401 (SDK verification active); `/icon.svg` serves 200 `image/svg+xml`; `/healthz` 200 | PROVED |
| IC-8 | The developer environment's embedding origin for the iframe is `https://developer.clockify.me` (CSP `frame-ancestors` must use it there; production keeps `https://app.clockify.me`) | PROVED (operator note + env convention; component load untested until the UI pass) |

## Remaining gaps after this capture

- Component iframe load with a real viewer token (LV-01) — needs the UI shell; the boundary
  (401 without token) is already proven.
- Production-environment re-confirmation (LV-02/LV-04) at release time.
- Cloudflared quick-tunnel URL is not durable: a tunnel restart changes `baseUrl` and forces a
  reinstall. Durable option: `cloudflared login` + named tunnel.

## Reproduction

```bash
cd tools/install-capture && npm ci
# tunnel: cloudflared tunnel --url http://127.0.0.1:8791
PUBLIC_BASE_URL=https://<tunnel-url> CLOCKIFY_PARENT_ORIGIN=https://developer.clockify.me node server.mjs
RT_INSTALLATION="69bda6b317a0c5babe34b4ff:6a76834a2a539b0829b7a5ae" node probe-addon-token.mjs
```
