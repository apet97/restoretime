# 12 — Security

## Boundaries

1. **Webhook boundary** — Clockify → addon. SDK verification: RS256 JWT (pinned platform key,
   `iss=clockify`, `sub=addonKey`, `type=addon`) + constant-time compare of the per-installation
   webhook token + event-type match + the app's own claims/payload `workspaceId` match (the SDK
   verifier does not compare the body to the claims — fact 8; mismatch → 400 + log, no row, and
   the row stores `claims.workspaceId`).
2. **Viewer boundary** — iframe → addon API. Verified component JWT per call, `exp` required. No
   cookies (no CSRF surface). Workspace and user identity come only from claims.
3. **Clockify boundary** — addon → Clockify REST. Installation `authToken` as `X-Addon-Token`
   (exactly one auth mode, R11). Token is server-side only, stored encrypted (SDK AES-256-GCM
   codec; key from `TOKEN_ENCRYPTION_KEY`).
4. **Tenant boundary** — every product-data query is scoped by the claims' `(workspaceId,
   addonId)` pair. `workspaceId` alone identifies the tenant; the pair identifies the installation
   generation that owns the row (docs/08, docs/09).

## Component token transport

Clockify supplies the component JWT in `?auth_token`. The SDK and browser contract require that
query value so a reload can receive the Clockify-supplied token. The server verifies the component
request, sends the HTML shell with `Cache-Control: no-store` and `Referrer-Policy: no-referrer`,
keeps the token out of application logs and server responses, and accepts it on `/api/*` only in
the `Authorization` header. Operators must redact query strings in reverse-proxy and platform
access logs for the component route. Do not strip the query from browser history.

## Threat model

| Threat | Boundary | Mitigation | Test |
|---|---|---|---|
| Forged webhook | 1 | SDK JWT + per-installation token verify; unknown installation → 401 | IT-02 |
| Webhook replay | 1 | Natural-key insert-if-absent; replay is a no-op | IT-01 |
| Tampered component token | 2 | RS256 verify with pinned platform key; `exp` required | SDK tests + IT-07 |
| User spoofing (`userId` in body) | 2 | Identity never read from body/path | IT-09 |
| Workspace spoofing | 2 | `workspaceId` from claims only | IT-09 |
| IDOR (entry id of another user) | 2 | Row scoped by workspace; `canRead/canAct` on owner | IT-07 |
| Regular user reads another's entry | 2 | `owner_id = viewer` filter; 404 otherwise | IT-07 |
| Admin demoted between view and POST | 2 | Fresh claims per call; P-PERM re-evaluated at execute | IT-07 |
| Source id tampering (plan for another entry) | 3 | Plan carries `sourceHash`; execute compares with the row | UT-S01 |
| Stale plan (deps changed) | 3 | Revalidation before mutation; STALE plan never executes | UT-S02 |
| TOCTOU (dep deleted after revalidate) | 3 | Create validates atomically; 4xx → mapped FAILED (R3) | IT-05 |
| Concurrent recreation | 2/3 | Atomic claim CAS + lease + fencing token | IT-03 |
| Duplicate mutation (blind retry) | 3 | POST never auto-retried (SDK default + app rule) | review + LV-04 |
| Ambiguous POST | 3 | AMBIGUOUS protocol; baseline-delta; double-adoption unique index | IT-04 |
| XSS via stored Clockify values | 2 | Escape all interpolated values; CSP `default-src 'none'`; `textContent` only | UT-X01 (+ E2E) |
| SQL injection | 4 | Prepared statements only; no string-built SQL | review |
| Sensitive log leakage | all | IDs/states/codes only; SDK `onError` redaction; no payload logging | IT-15 |
| Addon token exposure | 3 | Server-only; encrypted at rest; never in responses | IT-15 (never logged); review (never in responses) |
| Uninstall data residue | 1/4 | DELETED hard-deletes the installation's own data in one transaction, scoped by `(workspace_id, addon_id)`; a webhook still being verified is refused by a database-enforced generation fence, not an in-memory check; a missed DELETED is cleaned by the next install | IT-11, IT-21, IT-22 |
| Iframe embedding abuse | 2 | `frame-ancestors` restricted to `CLOCKIFY_PARENT_ORIGIN` (env var, fact 12) | LV-01 |
| Token replay across addons | 2 | JWT `sub` must equal this addon's key | SDK tests |

## Data protection

- Persisted: the normalized source and the recovery plans and attempts in docs/08. Plans hold the
  exact planned create request, choices, current labels, preview values, and rule results. Attempts
  can hold baseline IDs, candidate IDs, differences, and safe error fields. Raw webhook envelopes
  and rate objects are discarded at normalization (ADR-009).
- Logs: structured; fields limited to IDs, states, error codes, durations. Descriptions and
  custom-field values never logged.
- Encryption at rest: installation API tokens and webhook tokens use the SDK codec. The database
  file also holds potentially sensitive entry descriptions, custom-field values, plans, and
  attempts. Deployments place it on encrypted disks. Backups copy the file and inherit its
  sensitivity (docs/14).
- Uninstall: a purge of everything that installation generation owns, from the active database,
  when the lifecycle call arrives (F17). Another generation of the same workspace is untouched.
  It does not rewrite existing backup files. Status INACTIVE keeps data because the add-on can be
  re-enabled.
- Retention: the next preflight for an entry deletes its older unattempted STALE or CONSUMED
  plans. Plans linked to attempts remain for audit until uninstall. Baseline and candidate
  evidence remains only while an attempt is ambiguous; a definitive outcome clears it.

## What is not defended (explicit)

- A Clockify platform compromise is out of scope; the trust anchor is the pinned platform public key.
- Rate limiting of inbound requests beyond the 1 MiB body cap: the only public routes are
  Clockify-called (verified). The app API requires a signed short-lived token. A deployment can add
  a reverse-proxy limit without app changes.
