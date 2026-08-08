// Shared support for tests/live/* (docs/13 "Live suite"). Runs LV-01…LV-10 against the sacrificial
// workspace on whichever real Clockify environment `CK_LIVE_API_BASE` names — production by
// default, the developer environment when overridden. Nothing here is a simulation: every call
// leaves this machine. With any required env var missing, every LV test reports
// "blocked — no valid live installation (missing <VAR>)" and does **not** fail the pass — same
// convention as tests/dev-smoke/support.ts — and it is never silently skipped (`--passWithNoTests`
// is off for `npm run test:live`, so the files must exist and each must run and log its status).
//
// LV-03…LV-10 boot the app's own `createServer()` **in-process** with a test-signed platform key
// (`@apet97/clockify-addon-sdk/testing`, the identical pattern PASS-01…04's offline integration
// suite already uses for the JWT-verification boundary — e.g. tests/integration/performance.test.ts,
// tests/integration/lease-fencing-drill.test.ts). This is legitimate, not a weaker substitute: the
// platform-JWT boundary's behavior is unchanged from what those passes already prove correct with
// the same mechanism; the only thing this suite adds on top is that the installation's Clockify
// REST client is pointed at the target environment's real Clockify API and authenticates with the
// installation's own addon token, so every Clockify call the app makes goes out over the real
// network to the real sacrificial workspace.
// That is what proves R11 (API-key/addon-token REST equivalence) and R10 (`listForUser` field
// coverage) live — see docs/13.
//
// LV-01 and LV-02 are different in kind (real Clockify-issued claims / real webhook delivery to a
// real deployed host) and this in-process harness must never be used for them — they require
// `CK_LIVE_ADDON_BASE_URL` and report blocked without it (`checkLiveDeployedHost`).
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddonRequest } from "@apet97/clockify-addon-sdk";
import {
  buildInstalledPayload,
  createTestLifecycleRequest,
  generateTestKeys,
  signTestToken,
  type ClockifyTestKeys,
} from "@apet97/clockify-addon-sdk/testing";
import { ClockifyApiError, createClockifyClient, type ClockifyClient } from "clockify-sdk-ts-115";
import { createServer, type AppServer } from "../../src/server.js";
import type { AppConfig } from "../../src/config.js";
import { CLOCKIFY_CLIENT_TIMEOUT_SECONDS } from "../../src/clockify/client.js";
import { clockifyErrorCode } from "../../src/clockify/errors.js";
import * as entries from "../../src/store/entries.js";
import type { DeletedTimeEntry } from "../../src/domain/entry.js";

/**
 * Which Clockify the live suite talks to. Production by default; `CK_LIVE_API_BASE` overrides it
 * so the same suite can run against the developer environment, where the addon is installed and
 * where DS-01…DS-03 already run (docs/13 "Developer-environment smoke").
 *
 * This is the installation `apiUrl` shape (no `/v1`) — the addon SDK's `resolveClockifyApiBaseUrl`
 * appends the version, exactly as it does for a real INSTALLED payload.
 */
export const LIVE_API_URL = (process.env.CK_LIVE_API_BASE ?? "https://api.clockify.me/api").replace(/\/+$/, "");
export const RT_PROBE_PREFIX = "RT-PROBE-";
export const LIVE_ADDON_KEY = "restoretime-live-suite";
export const LIVE_ADDON_ID = "restoretime-live-addon";

// --- Env gating -----------------------------------------------------------------------------

const REQUIRED_VARS = ["CK_LIVE_API_KEY", "CK_LIVE_WS"] as const;

export interface LiveEnv {
  readonly apiKey: string;
  readonly workspaceId: string;
  /** The installation `authToken` Clockify issued when the addon was installed on this workspace.
   * Present only once a real installation exists; the app-driving rows require it (R11). */
  readonly addonToken?: string;
}

export type EnvCheck = { readonly blocked: false; readonly env: LiveEnv } | { readonly blocked: true; readonly reason: string };

export function checkLiveEnv(): EnvCheck {
  for (const name of REQUIRED_VARS) {
    const value = process.env[name];
    if (value === undefined || value.trim() === "") {
      return { blocked: true, reason: `blocked — no valid live installation (missing ${name})` };
    }
  }
  return {
    blocked: false,
    env: {
      apiKey: process.env.CK_LIVE_API_KEY!,
      workspaceId: process.env.CK_LIVE_WS!,
      ...(process.env.CK_LIVE_ADDON_TOKEN ? { addonToken: process.env.CK_LIVE_ADDON_TOKEN } : {}),
    },
  };
}

/**
 * The rows that drive the APP (LV-03…LV-10) need a real Clockify-issued **addon token**, because
 * the app authenticates every Clockify call as an addon (`X-Addon-Token`, ADR-004/R11). An API key
 * cannot stand in: Clockify rejects one in that header with `401 code 4017`.
 *
 * That token only exists once the addon is installed on the sacrificial workspace — it arrives in
 * the INSTALLED lifecycle payload. Requiring it here is what makes LV-04 mean what docs/13 says it
 * means: proof that the addon token works on the real addon path, not proof that an API key does.
 */
export function checkLiveAddonToken(env: LiveEnv): EnvCheck {
  if (!env.addonToken) {
    return {
      blocked: true,
      reason:
        "blocked — no valid live installation (missing CK_LIVE_ADDON_TOKEN: the installation authToken Clockify sent when the addon was installed on the sacrificial workspace). An API key cannot substitute — the app authenticates as an addon (R11).",
    };
  }
  return { blocked: false, env };
}

export type HostCheck = { readonly blocked: false; readonly addonBaseUrl: string } | { readonly blocked: true; readonly reason: string };

/** LV-01/LV-02 only: a real deployed, already-installed instance. Distinct from `checkLiveEnv`
 * because these two rows cannot be satisfied by the in-process test-signed harness at all — see
 * the module header and docs/13 "Live suite". */
export function checkLiveDeployedHost(): HostCheck {
  const raw = process.env.CK_LIVE_ADDON_BASE_URL;
  if (raw === undefined || raw.trim() === "") {
    return {
      blocked: true,
      reason:
        "blocked — no valid live installation (missing CK_LIVE_ADDON_BASE_URL: the public base URL of a RestoreTime instance already deployed and already installed on the sacrificial workspace)",
    };
  }
  return { blocked: false, addonBaseUrl: raw.replace(/\/+$/, "") };
}

/** A Clockify auth rejection is a real, actionable live finding (R11 resolving negatively), never
 * silently swallowed as "blocked" — `checkLiveEnv`/`checkLiveDeployedHost` are the only blocked
 * paths this suite has. Exported only for tests that want to produce a clearer failure message
 * when a rejection happens; it is never used to turn a failure into a pass. */
export function describeIfAuthRejected(err: unknown): string | undefined {
  if (!(err instanceof ClockifyApiError) || err.statusCode !== 401) return undefined;
  const code = clockifyErrorCode(err) ?? "unknown";
  // R11: 4003 means "bad API key", 4017 means "bad addon token" — two credentials in two headers.
  // Only 4003 says anything about `CK_LIVE_API_KEY` itself. A 4017 while this run holds an API key
  // means the key reached the `X-Addon-Token` header, which is a wiring fault in the harness, not
  // a platform finding — claiming otherwise would blame Clockify for our own mistake.
  if (code === "4003") return "Clockify rejected CK_LIVE_API_KEY (401 code 4003 — bad API key). Check the credential.";
  if (code === "4017") {
    return "Clockify rejected an addon token (401 code 4017). If this run supplied only an API key, that key reached the X-Addon-Token header — a harness wiring fault, not an R11 finding.";
  }
  return `Clockify rejected the credential (401 code ${code}).`;
}

// --- Direct REST probe client (mirrors tests/dev-smoke/support.ts's buildDevClient) ----------

/** For probes that talk to Clockify directly, outside the app (seed/cleanup data, capture the
 * pre-delete shape of an entry). Never used for anything the app itself would do — those go
 * through `LiveHarness.apiCall`, which drives the real routes. */
/**
 * A non-archived project from the workspace, or `undefined` when it has none.
 *
 * Probe entries must carry a project whenever the workspace sets `forceProjects` (R4): a completed
 * create without one is rejected with `400 code 501`. Attaching one unconditionally also makes the
 * fixture realistic — a deleted entry on such a workspace always had a project — and archived
 * projects are excluded because Clockify refuses creates against them for the same rule.
 */
export async function pickUsableProject(
  client: ClockifyClient,
  workspaceId: string,
): Promise<{ id: string; name: string } | undefined> {
  const projects = await client.projects.list({ workspaceId, "page-size": 200 });
  const usable = projects.find((p) => !p.archived && p.id !== undefined);
  return usable?.id === undefined ? undefined : { id: usable.id, name: usable.name ?? usable.id };
}

export function buildLiveRestClient(env: LiveEnv): ClockifyClient {
  // Built with the SDK's `apiKey` mode, NOT the app's `buildClockifyClient`. `CK_LIVE_API_KEY` is
  // a personal API key, and the app's factory always sends its credential as `X-Addon-Token`.
  // Clockify rejects an API key in that header with `401 code 4017` ("bad addon token") — the two
  // auth modes are distinct headers (R11), so this probe uses the one matching the credential it
  // actually holds.
  return createClockifyClient({
    apiKey: env.apiKey,
    baseUrl: `${LIVE_API_URL}/v1`,
    timeoutInSeconds: CLOCKIFY_CLIENT_TIMEOUT_SECONDS,
  });
}

// --- In-process harness (LV-03…LV-10) ---------------------------------------------------------

export interface LiveHarness {
  readonly server: AppServer;
  readonly keys: ClockifyTestKeys;
  readonly env: LiveEnv;
  readonly dir: string;
}

/** Boots the real `createServer()` against a throwaway local SQLite file and installs it with a
 * test-signed lifecycle event carrying the real Clockify API base for the target environment and the REAL installation
 * addon token. From this point every Clockify call the booted server makes goes out over the real
 * network, authenticated exactly as the shipped product authenticates — as an addon.
 *
 * Callers must have passed `checkLiveAddonToken` first; this throws rather than silently falling
 * back to the API key, which would send the wrong header and prove nothing about R11. */
export async function bootLiveHarness(env: LiveEnv): Promise<LiveHarness> {
  if (!env.addonToken) {
    throw new Error("bootLiveHarness requires env.addonToken — call checkLiveAddonToken first.");
  }
  const dir = mkdtempSync(join(tmpdir(), "restoretime-live-"));
  const keys: ClockifyTestKeys = await generateTestKeys();
  const config: AppConfig = {
    port: 0,
    publicBaseUrl: "https://addon.example.invalid",
    clockifyParentOrigin: "https://app.clockify.me",
    databasePath: join(dir, "restoretime.sqlite"),
    addonKey: LIVE_ADDON_KEY,
    // A per-boot random key, not a fixed constant. This harness stores the operator's REAL
    // installation addon token, and the SDK codec encrypts it at rest — under an all-zero key that
    // would be effectively plaintext to anyone who reads this file. A run killed before teardown
    // leaves that database in a temp directory.
    tokenEncryptionKeyHex: randomBytes(32).toString("hex"),
    logLevel: "error",
  };
  const server = await createServer(config, { publicKey: keys.publicKey });
  const installToken = await signTestToken(keys.privateKey, LIVE_ADDON_KEY, {
    workspaceId: env.workspaceId,
    addonId: LIVE_ADDON_ID,
  });
  await server.addon.handle(
    createTestLifecycleRequest(
      installToken,
      buildInstalledPayload({
        workspaceId: env.workspaceId,
        addonId: LIVE_ADDON_ID,
        apiUrl: LIVE_API_URL,
        authToken: env.addonToken,
      }),
      { path: "/lifecycle/installed" },
    ),
  );
  return { server, keys, env, dir };
}

export function teardownLiveHarness(harness: LiveHarness): void {
  rmSync(harness.dir, { recursive: true, force: true });
}

export interface CallViewer {
  readonly userId: string;
  readonly workspaceRole: "admin" | "member";
}

/** Drives one `/api/*` call through the real route layer with a freshly test-signed component
 * token — the same `server.addon.handle` shape every offline integration test drives. */
export async function apiCall(
  harness: LiveHarness,
  viewer: CallViewer,
  request: Omit<AddonRequest, "headers"> & { readonly headers?: AddonRequest["headers"] },
): Promise<Awaited<ReturnType<AppServer["addon"]["handle"]>>> {
  const token = await signTestToken(harness.keys.privateKey, LIVE_ADDON_KEY, {
    workspaceId: harness.env.workspaceId,
    addonId: LIVE_ADDON_ID,
    user: viewer.userId,
    workspaceRole: viewer.workspaceRole,
  });
  return harness.server.addon.handle({
    ...request,
    headers: { ...(request.headers ?? {}), authorization: `Bearer ${token}` },
  });
}

/** Seeds a `recoverable_entries` row directly from a real (pre-deletion) Clockify time entry —
 * standing in for "the webhook already delivered" (webhook ingestion correctness is proved
 * exhaustively offline: IT-01/02, CT-01…05; LV-02 is the row that proves live delivery itself).
 * `source` must be built from data captured BEFORE the real delete call. */
export function seedRecoverableEntry(
  harness: LiveHarness,
  input: { readonly id: string; readonly sourceEntryId: string; readonly ownerId: string; readonly source: DeletedTimeEntry },
) {
  return entries.ingestDeletedEntry(harness.server.db, {
    id: input.id,
    workspaceId: harness.env.workspaceId,
    sourceEntryId: input.sourceEntryId,
    ownerId: input.ownerId,
    detectedAt: new Date().toISOString(),
    source: input.source,
  }).entry;
}

/** A "recording passthrough" `fetch`: delegates to the real network but records every request's
 * method + full URL first (LV-09 needs to observe the exact call shape `runReconcile`/preflight
 * issue while still hitting the real API — a plain stub can't do both). Kept separate from the
 * `RT_CHAOS_FETCH` seam (src/clockify/chaos-fetch.ts): this wrapper never alters behavior, only
 * observes it.
 *
 * `REAL_FETCH` is captured at module load, NOT read as the bare `fetch` identifier inside the
 * returned closure: a caller installs this wrapper as `globalThis.fetch` (`vi.stubGlobal("fetch",
 * ...)`) specifically so the app's own internal Clockify client — which never receives an injected
 * `fetch` option — gets recorded too. A bare `fetch(...)` call inside the closure would resolve
 * through the global object AT CALL TIME, which by then is this same wrapper, recursing until the
 * stack overflows on the very first request. Capturing the real implementation once, before any
 * stubbing happens, is what makes "record everything, forward to the real network" possible at
 * all — proved by the offline test in `tests/live/support.test.ts` (needs no credential). */
const REAL_FETCH: typeof fetch = globalThis.fetch;

export function recordingPassthroughFetch(sink: { method: string; url: string }[]): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    sink.push({ method: request.method, url: request.url });
    return REAL_FETCH(input, init);
  };
}

/** Builds a `DeletedTimeEntry` (docs/06) from a real Clockify `TimeEntry` fetched before deletion —
 * the exact normalization shape `src/ingest/deleted-entry.ts` produces from a live webhook, built
 * here by hand because the LV harness does not receive a real webhook (that is LV-02's job). */
export function deletedEntryFromLiveTimeEntry(
  entry: {
    readonly id: string;
    readonly workspaceId: string;
    readonly userId: string;
    readonly description: string;
    readonly billable: boolean;
    readonly projectId?: string | null;
    readonly taskId?: string | null;
    readonly tagIds?: readonly string[] | null;
    readonly timeInterval: { readonly start?: string | null; readonly end?: string | null };
    // The SDK's own `TimeEntry.customFieldValues` type is `Record<string, unknown>[]` (untyped
    // per-item, mirroring `src/clockify/recreate.ts`'s own handling of the same field) — the real
    // shape at runtime has `customFieldId`/`value`/`name`, read defensively below.
    readonly customFieldValues?: readonly Record<string, unknown>[] | null;
  },
  ownerName: string,
  projectName: string | null,
  tagNames: ReadonlyMap<string, string>,
): DeletedTimeEntry {
  const start = entry.timeInterval.start;
  if (start === undefined || start === null) {
    throw new Error(`deletedEntryFromLiveTimeEntry: entry ${entry.id} has no timeInterval.start — cannot build a DeletedTimeEntry from it`);
  }
  return {
    workspaceId: entry.workspaceId,
    entryId: entry.id,
    ownerId: entry.userId,
    ownerName,
    description: entry.description,
    billable: entry.billable,
    start,
    end: entry.timeInterval.end ?? null,
    wasRunning: entry.timeInterval.end === undefined || entry.timeInterval.end === null,
    type: "REGULAR",
    timeZone: null,
    projectId: entry.projectId ?? null,
    projectName,
    clientName: null,
    taskId: entry.taskId ?? null,
    taskName: null,
    tags: (entry.tagIds ?? []).map((id) => ({ id, name: tagNames.get(id) ?? id })),
    customFieldValues: (entry.customFieldValues ?? []).map((v) => {
      const customFieldId = String(v.customFieldId ?? "");
      const name = typeof v.name === "string" ? v.name : customFieldId;
      return { customFieldId, name, value: v.value };
    }),
  };
}
