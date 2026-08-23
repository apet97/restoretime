// Shared support for tests/live/* (docs/13 "Live suite"). Runs LV-01…LV-10 against the sacrificial
// workspace on the explicit Clockify environment named by `CK_LIVE_TARGET`. A developer-candidate
// run accepts only `developer`: the suite mutates real entries, and an implicit production default
// is unsafe.
// Nothing here is a simulation: every Clockify call leaves this machine. `npm run test:live` is a
// diagnostic command, so a missing prerequisite is reported as BLOCKED. `npm run
// test:live:release` sets `CK_LIVE_STRICT=1`; the same condition throws and fails the release gate.
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
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import type { DeletedTimeEntry, InstallationScope } from "../../src/domain/entry.js";
import { ingestEntry } from "../support/installation-fixture.js";

/**
 * Which Clockify the live suite talks to. The suite requires the explicit developer API URL,
 * where the add-on is installed and where DS-01…DS-03 already run (docs/13).
 *
 * This is the installation `apiUrl` shape (no `/v1`) — the addon SDK's `resolveClockifyApiBaseUrl`
 * appends the version, exactly as it does for a real INSTALLED payload.
 */
const DEVELOPER_API_URL = "https://developer.clockify.me/api";
const DEVELOPER_PARENT_ORIGIN = "https://developer.clockify.me";
export const LIVE_API_URL = (process.env.CK_LIVE_API_BASE ?? "").replace(/\/+$/, "");
export const RT_PROBE_PREFIX = "RT-PROBE-";
export const LIVE_ADDON_KEY = "restoretime-live-suite";
export const LIVE_ADDON_ID = "restoretime-live-addon";

// --- Env gating -----------------------------------------------------------------------------

const REQUIRED_VARS = [
  "CK_LIVE_TARGET",
  "CK_LIVE_API_KEY",
  "CK_LIVE_API_USER_ID",
  "CK_LIVE_WS",
  "CK_LIVE_ADDON_ID",
  "CK_LIVE_ADDON_KEY",
  "CK_LIVE_API_BASE",
] as const;

export function isStrictLiveRelease(): boolean {
  return process.env.CK_LIVE_STRICT === "1";
}

function blocked(reason: string): { readonly blocked: true; readonly reason: string } {
  if (isStrictLiveRelease()) throw new Error(`release gate blocked — ${reason}`);
  return { blocked: true, reason: `blocked — ${reason}` };
}

/** The installation generation the live suite works against: the configured developer workspace
 * plus the add-on identity from `CK_LIVE_ADDON_ID`. Every scoped store call in the live tests goes
 * through this rather than re-deriving the pair. */
export function liveScope(env: LiveEnv): InstallationScope {
  return { workspaceId: env.workspaceId, addonId: env.addonId };
}

export interface LiveEnv {
  readonly apiKey: string;
  readonly apiUserId: string;
  readonly workspaceId: string;
  readonly target: "developer";
  readonly addonId: string;
  readonly addonKey: string;
  readonly candidateId?: string;
  readonly lv02SourceId?: string;
  /** The installation `authToken` Clockify issued when the addon was installed on this workspace.
   * Present only once a real installation exists; the app-driving rows require it (R11). */
  readonly addonToken?: string;
}

export type EnvCheck = { readonly blocked: false; readonly env: LiveEnv } | { readonly blocked: true; readonly reason: string };

export function checkLiveEnv(options: { readonly requireReleaseIdentity?: boolean } = {}): EnvCheck {
  for (const name of REQUIRED_VARS) {
    const value = process.env[name];
    if (value === undefined || value.trim() === "") {
      return blocked(`no valid live installation (missing ${name})`);
    }
  }
  if (process.env.CK_LIVE_TARGET !== "developer") {
    return blocked("CK_LIVE_TARGET must be developer for this mutating suite");
  }
  if (process.env.CK_LIVE_API_BASE!.replace(/\/+$/, "") !== DEVELOPER_API_URL) {
    return blocked(`CK_LIVE_API_BASE must be ${DEVELOPER_API_URL} when CK_LIVE_TARGET=developer`);
  }
  const requireReleaseIdentity = options.requireReleaseIdentity ?? true;
  if (isStrictLiveRelease() && requireReleaseIdentity && !process.env.CK_LIVE_CANDIDATE_ID?.trim()) {
    return blocked("no candidate identity (missing CK_LIVE_CANDIDATE_ID)");
  }
  if (
    isStrictLiveRelease() &&
    requireReleaseIdentity &&
    process.env.CK_LIVE_LV02_TRIGGER !== "1" &&
    !process.env.CK_LIVE_LV02_SOURCE_ID?.trim()
  ) {
    return blocked("no correlated LV-02 trigger identity (missing CK_LIVE_LV02_SOURCE_ID)");
  }
  return {
    blocked: false,
    env: {
      apiKey: process.env.CK_LIVE_API_KEY!,
      apiUserId: process.env.CK_LIVE_API_USER_ID!,
      workspaceId: process.env.CK_LIVE_WS!,
      target: "developer",
      addonId: process.env.CK_LIVE_ADDON_ID!,
      addonKey: process.env.CK_LIVE_ADDON_KEY!,
      ...(process.env.CK_LIVE_CANDIDATE_ID ? { candidateId: process.env.CK_LIVE_CANDIDATE_ID } : {}),
      ...(process.env.CK_LIVE_LV02_SOURCE_ID ? { lv02SourceId: process.env.CK_LIVE_LV02_SOURCE_ID } : {}),
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
    return blocked(
      "no valid live installation (missing CK_LIVE_ADDON_TOKEN: the installation authToken Clockify sent when the addon was installed on the sacrificial workspace). An API key cannot substitute — the app authenticates as an addon (R11).",
    );
  }
  if (isStrictLiveRelease() && (!process.env.CK_DEV_WORKSPACE_ID || !process.env.CK_DEV_ADDON_ID || !process.env.CK_DEV_ADDON_TOKEN)) {
    return blocked("the strict command must run through scripts/live-env.sh so the exact Railway installation identity is present");
  }
  if (isStrictLiveRelease() && process.env.CK_LIVE_INSTALLATION_SOURCE !== "railway-handoff") {
    return blocked("the strict command requires the candidate-bound Railway installation handoff; a local installation row is not release proof");
  }
  if (isStrictLiveRelease()) {
    const handoffFields = {
      CK_LIVE_HANDOFF_PROJECT_ID: process.env.CK_RAILWAY_PROJECT_ID,
      CK_LIVE_HANDOFF_ENVIRONMENT_ID: process.env.CK_RAILWAY_ENVIRONMENT_ID,
      CK_LIVE_HANDOFF_SERVICE_ID: process.env.CK_RAILWAY_SERVICE_ID,
      CK_LIVE_HANDOFF_DEPLOYMENT_ID: process.env.CK_RAILWAY_DEPLOYMENT_ID,
      CK_LIVE_HANDOFF_DEPLOYMENT_INSTANCE_ID: process.env.CK_RAILWAY_DEPLOYMENT_INSTANCE_ID,
      CK_LIVE_HANDOFF_CANDIDATE_ID: env.candidateId,
    };
    for (const [name, expected] of Object.entries(handoffFields)) {
      if (!expected || process.env[name] !== expected) {
        return blocked(`the Railway installation handoff ${name} does not match the release target`);
      }
    }
  }
  if (process.env.CK_DEV_WORKSPACE_ID && process.env.CK_DEV_WORKSPACE_ID !== env.workspaceId) {
    return blocked("the selected installation workspace does not match CK_LIVE_WS");
  }
  if (process.env.CK_DEV_ADDON_ID && process.env.CK_DEV_ADDON_ID !== env.addonId) {
    return blocked("the selected installation add-on does not match CK_LIVE_ADDON_ID");
  }
  if (process.env.CK_DEV_ADDON_TOKEN && process.env.CK_DEV_ADDON_TOKEN !== env.addonToken) {
    return blocked("the selected installation token does not match CK_LIVE_ADDON_TOKEN");
  }
  if (isStrictLiveRelease()) {
    const parts = env.addonToken.split(".");
    let claims: unknown;
    try {
      if (parts.length !== 3 || !parts[1]) throw new Error("not a JWT");
      claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    } catch {
      return blocked("the selected installation token does not contain a valid JWT payload");
    }
    if (!isRecord(claims)) return blocked("the selected installation token JWT payload is not an object");
    const exactClaims: Readonly<Record<string, string>> = {
      iss: "clockify",
      sub: env.addonKey,
      type: "addon",
      workspaceId: env.workspaceId,
      addonId: env.addonId,
    };
    for (const [claim, expected] of Object.entries(exactClaims)) {
      if (claims[claim] !== expected) {
        return blocked(`the selected installation token ${claim} claim does not match ${claim === "sub" ? "CK_LIVE_ADDON_KEY" : claim === "workspaceId" ? "CK_LIVE_WS" : claim === "addonId" ? "CK_LIVE_ADDON_ID" : expected}`);
      }
    }
    if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= Date.now() / 1000) {
      return blocked("the selected installation token exp claim is invalid or expired");
    }
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
    return blocked(
      "no valid live installation (missing CK_LIVE_ADDON_BASE_URL: the public base URL of a RestoreTime instance already deployed and already installed on the sacrificial workspace)",
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return blocked("CK_LIVE_ADDON_BASE_URL must be a valid HTTPS origin");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return blocked("CK_LIVE_ADDON_BASE_URL must be an HTTPS origin with no path, query, fragment, or credentials");
  }
  return { blocked: false, addonBaseUrl: url.origin };
}

export function skipOrFailLiveScenario(ctx: { skip(reason?: string): void }, reason: string): void {
  if (isStrictLiveRelease()) throw new Error(`release gate blocked — ${reason}`);
  ctx.skip(reason);
}

export async function assertLiveTargetIdentity(
  env: LiveEnv,
  client: ClockifyClient = buildLiveRestClient(env),
): Promise<{ readonly userId: string; readonly workspaceName: string }> {
  const [user, workspace] = await Promise.all([
    client.users.getCurrentUser({ "include-memberships": true }),
    client.workspaces.get({ workspaceId: env.workspaceId }),
  ]);
  if (workspace.id !== env.workspaceId) {
    throw new Error(`live target mismatch: workspace lookup returned ${String(workspace.id)}, expected ${env.workspaceId}`);
  }
  if (user.id !== env.apiUserId) {
    throw new Error(`live target mismatch: API-key user ${user.id} does not match CK_LIVE_API_USER_ID ${env.apiUserId}`);
  }
  const activeMembership = user.memberships?.some(
    (membership) =>
      membership.membershipType === "WORKSPACE" &&
      membership.targetId === env.workspaceId &&
      membership.membershipStatus === "ACTIVE",
  );
  if (!activeMembership) {
    throw new Error(`live target mismatch: API-key user ${user.id} has no ACTIVE membership in ${env.workspaceId}`);
  }
  return { userId: user.id, workspaceName: workspace.name ?? env.workspaceId };
}

interface LiveMutationTargetOptions {
  readonly apiKeyClient?: ClockifyClient;
  readonly addonClient?: ClockifyClient;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Safety fence for every row that can mutate the sacrificial workspace. It verifies both
 * credentials and the deployed candidate before the caller can issue its first mutation. Test
 * files must call this directly; Vitest file order is not a safety boundary.
 */
export async function assertLiveMutationTarget(
  env: LiveEnv,
  addonBaseUrl: string,
  options: LiveMutationTargetOptions = {},
): Promise<void> {
  if (!env.addonToken) {
    throw new Error("live mutation target requires CK_LIVE_ADDON_TOKEN");
  }
  const apiKeyClient = options.apiKeyClient ?? buildLiveRestClient(env);
  const apiUser = await apiKeyClient.users.getCurrentUser({ "include-memberships": true });
  const apiWorkspace = await apiKeyClient.workspaces.get({ workspaceId: env.workspaceId });
  if (apiWorkspace.id !== env.workspaceId) {
    throw new Error(`live mutation target mismatch: API-key workspace returned ${String(apiWorkspace.id)}, expected ${env.workspaceId}`);
  }
  if (apiUser.id !== env.apiUserId) {
    throw new Error(`live mutation target mismatch: API-key user ${apiUser.id} does not match CK_LIVE_API_USER_ID ${env.apiUserId}`);
  }
  const activeApiMembership = apiUser.memberships?.some(
    (membership) =>
      membership.membershipType === "WORKSPACE" &&
      membership.targetId === env.workspaceId &&
      membership.membershipStatus === "ACTIVE",
  );
  if (!activeApiMembership) {
    throw new Error(`live mutation target mismatch: API-key user ${apiUser.id} has no ACTIVE membership in ${env.workspaceId}`);
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const manifestResponse = await fetchImpl(`${addonBaseUrl}/manifest`);
  if (!manifestResponse.ok) {
    throw new Error(`live mutation target mismatch: deployed manifest returned HTTP ${manifestResponse.status}`);
  }
  const manifest = (await manifestResponse.json()) as { key?: unknown; baseUrl?: unknown };
  if (manifest.key !== env.addonKey) {
    throw new Error(`live mutation target mismatch: deployed manifest key does not match ${env.addonKey}`);
  }
  if (typeof manifest.baseUrl !== "string" || manifest.baseUrl.replace(/\/+$/, "") !== addonBaseUrl) {
    throw new Error(`live mutation target mismatch: deployed manifest baseUrl does not match ${addonBaseUrl}`);
  }

  const addonClient =
    options.addonClient ??
    createClockifyClient({
      addonToken: env.addonToken,
      baseUrl: `${LIVE_API_URL}/v1`,
      timeoutInSeconds: CLOCKIFY_CLIENT_TIMEOUT_SECONDS,
    });
  const addonUser = await addonClient.users.getCurrentUser({ "include-memberships": true });
  const addonWorkspace = await addonClient.workspaces.get({ workspaceId: env.workspaceId });
  if (addonWorkspace.id !== env.workspaceId) {
    throw new Error(
      `live mutation target mismatch: add-on ${env.addonId} token read workspace ${String(addonWorkspace.id)}, expected ${env.workspaceId}`,
    );
  }
  const activeAddonMembership = addonUser.memberships?.some(
    (membership) =>
      membership.membershipType === "WORKSPACE" &&
      membership.targetId === env.workspaceId &&
      membership.membershipStatus === "ACTIVE",
  );
  if (!activeAddonMembership) {
    throw new Error(
      `live mutation target mismatch: add-on ${env.addonId} token identity ${addonUser.id} has no ACTIVE membership in ${env.workspaceId}`,
    );
  }
}

type ReceiptRow = "LV-01B" | "LV-02B";

interface ReceiptExpected {
  readonly row: ReceiptRow;
  readonly env: LiveEnv;
  readonly addonBaseUrl: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateLiveReceipt(value: unknown, expected: ReceiptExpected): string | undefined {
  if (!isRecord(value)) return "receipt must be a JSON object";
  const expectedCommon: Readonly<Record<string, string | number>> = {
    schemaVersion: 1,
    row: expected.row,
    target: expected.env.target,
    workspaceId: expected.env.workspaceId,
    addonId: expected.env.addonId,
    addonKey: expected.env.addonKey,
    addonBaseUrl: expected.addonBaseUrl,
    candidateId: expected.env.candidateId ?? "",
  };
  for (const [field, wanted] of Object.entries(expectedCommon)) {
    if (value[field] !== wanted) return `${expected.row} receipt ${field} does not match the release environment`;
  }
  const observedAt = value.observedAt;
  if (typeof observedAt !== "string" || !Number.isFinite(Date.parse(observedAt))) {
    return `${expected.row} receipt observedAt must be an ISO timestamp`;
  }
  if (typeof value.evidence !== "string" || value.evidence.trim() === "") {
    return `${expected.row} receipt evidence must identify the operator evidence`;
  }
  if (expected.row === "LV-01B") {
    if (value.authenticatedComponentRendered !== true) return "LV-01B receipt must confirm authenticatedComponentRendered";
    if (value.sidebarIconRendered !== true) return "LV-01B receipt must confirm sidebarIconRendered";
    if (value.deletedEntryListLoaded !== true) return "LV-01B receipt must confirm deletedEntryListLoaded";
    if (value.contentSecurityPolicyVerified !== true) return "LV-01B receipt must confirm contentSecurityPolicyVerified";
    if (value.appConsoleErrorCount !== 0) return "LV-01B receipt appConsoleErrorCount must be 0";
    if (value.cspErrorCount !== 0) return "LV-01B receipt cspErrorCount must be 0";
    if (value.frameAncestorsOrigin !== DEVELOPER_PARENT_ORIGIN) {
      return `LV-01B receipt frameAncestorsOrigin must be ${DEVELOPER_PARENT_ORIGIN}`;
    }
  } else {
    if (!expected.env.lv02SourceId) {
      return "LV-02B validation requires CK_LIVE_LV02_SOURCE_ID from the trigger-only run";
    }
    if (value.sourceEntryId !== expected.env.lv02SourceId) {
      return "LV-02B receipt sourceEntryId does not match CK_LIVE_LV02_SOURCE_ID";
    }
    if (value.railwayWebhookLogCorrelated !== true) {
      return "LV-02B receipt must confirm railwayWebhookLogCorrelated";
    }
    if (value.remoteSqliteRowPresent !== true) return "LV-02B receipt must confirm remoteSqliteRowPresent";
  }
  return undefined;
}

export type ReceiptCheck =
  | { readonly blocked: false; readonly receipt: Record<string, unknown> }
  | { readonly blocked: true; readonly reason: string };

export function checkLiveReceipt(expected: ReceiptExpected): ReceiptCheck {
  const envName = expected.row === "LV-01B" ? "CK_LIVE_LV01B_RECEIPT" : "CK_LIVE_LV02B_RECEIPT";
  const path = process.env[envName]?.trim();
  if (!path) return blocked(`missing ${envName}: an operator receipt is required for ${expected.row}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    return blocked(`${expected.row} receipt could not be read as JSON (${error instanceof Error ? error.message : "unknown error"})`);
  }
  const error = validateLiveReceipt(parsed, expected);
  if (error) return blocked(error);
  return { blocked: false, receipt: parsed as Record<string, unknown> };
}

export function assertNoSkippedLiveTests(testOutput: string): void {
  if (/(?:Tests|Test Files)\s+[^\n]*?[1-9]\d* skipped/.test(testOutput)) {
    throw new Error("release gate blocked — strict live run reported a skipped test");
  }
  if (/\bPARTIAL\b|\bblocked —|^LV-[^\n]*\bSKIP(?:PED)?\b|^(?:BLOCKED|SKIP(?:PED)?)\b/im.test(testOutput)) {
    throw new Error("release gate blocked — strict live run reported an incomplete scenario");
  }
}

export interface LiveCleanupStep {
  readonly label: string;
  readonly run: () => Promise<unknown>;
}

/** Run every cleanup step. A failed strict cleanup fails the row after all remaining steps run. */
export async function runLiveCleanup(steps: readonly LiveCleanupStep[]): Promise<void> {
  const failures: string[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch {
      failures.push(step.label);
    }
  }
  if (failures.length === 0) return;
  const message = `live cleanup failed for: ${failures.join(", ")}`;
  if (isStrictLiveRelease()) throw new Error(message);
  console.error(message);
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

/**
 * A value for every active custom field the workspace marks `required` with no default.
 *
 * R22, proved live 2026-08-08: a create that omits them is rejected with
 * `400 {"message":" <field names>","code":501}`. Any real client has to supply them, so probe
 * fixtures do too — otherwise a workspace that turns on a required field breaks every row for a
 * reason that has nothing to do with recreation.
 *
 * Returns both shapes: `create` for the `customFields` key on a create request, and `source` for
 * the `customFieldValues` array on a `DeletedTimeEntry`.
 */
export async function requiredCustomFieldValues(
  client: ClockifyClient,
  workspaceId: string,
): Promise<{
  create: { customFieldId: string; sourceType: "WORKSPACE"; value: unknown }[];
  source: { customFieldId: string; name: string; value: unknown }[];
}> {
  const fields = await client.customFields.listForWorkspace({
    workspaceId,
    "entity-type": ["TIMEENTRY"],
    "page-size": 200,
  });
  const required = fields.filter(
    (f) => f.id !== undefined && f.status !== "INACTIVE" && f.required === true && f.workspaceDefaultValue == null,
  );
  const create = required.map((f) => ({
    customFieldId: f.id!,
    sourceType: "WORKSPACE" as const,
    // A dropdown only accepts one of its own options here; anything else is a free-text value.
    value: f.type === "DROPDOWN_SINGLE" ? (f.allowedValues?.[0] ?? `${RT_PROBE_PREFIX}value`) : `${RT_PROBE_PREFIX}value`,
  }));
  const source = create.map((c, i) => ({ customFieldId: c.customFieldId, name: required[i]?.name ?? c.customFieldId, value: c.value }));
  return { create, source };
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

const CLEANUP_PAGE_SIZE = 200;
const CLEANUP_MAX_PAGES = 100;

async function listAllWorkspaceUsers(client: ClockifyClient, workspaceId: string): Promise<readonly { readonly id: string }[]> {
  const users: { id: string }[] = [];
  for (let page = 1; page <= CLEANUP_MAX_PAGES; page += 1) {
    const next = await client.users.list({
      workspaceId,
      status: "ALL",
      "include-roles": false,
      page,
      "page-size": CLEANUP_PAGE_SIZE,
    });
    users.push(...next.map((user) => ({ id: user.id })));
    if (next.length < CLEANUP_PAGE_SIZE) return users;
  }
  throw new Error(`live cleanup exceeded ${CLEANUP_MAX_PAGES} user pages; the scan was not complete`);
}

interface ProbeEntryRef {
  readonly id: string;
  readonly userId: string;
}

/**
 * Scan every current or deactivated workspace user and every returned time-entry page, not only
 * the API-key user. A deactivated user can still own an active entry. The prefix check prevents
 * cleanup from deleting a non-probe entry. Page limits make an incomplete scan fail instead of
 * looping without a bound.
 */
export async function scanAllWorkspaceProbeEntries(client: ClockifyClient, workspaceId: string): Promise<readonly ProbeEntryRef[]> {
  const users = await listAllWorkspaceUsers(client, workspaceId);
  const probes: ProbeEntryRef[] = [];
  for (const user of users) {
    for (let page = 1; page <= CLEANUP_MAX_PAGES; page += 1) {
      const entries = await client.timeEntries.listForUser({
        workspaceId,
        userId: user.id,
        page,
        "page-size": CLEANUP_PAGE_SIZE,
      });
      for (const entry of entries) {
        if (entry.id && entry.description?.startsWith(RT_PROBE_PREFIX)) {
          probes.push({ id: entry.id, userId: user.id });
        }
      }
      if (entries.length < CLEANUP_PAGE_SIZE) break;
      if (page === CLEANUP_MAX_PAGES) {
        throw new Error(`live cleanup exceeded ${CLEANUP_MAX_PAGES} time-entry pages for user ${user.id}; the scan was not complete`);
      }
    }
  }
  return probes;
}

/** Release teardown: delete all active RestoreTime probes, then prove a bounded second scan is empty. */
export async function cleanupAllWorkspaceProbes(
  env: LiveEnv,
  client: ClockifyClient = buildLiveRestClient(env),
): Promise<{ readonly deleted: number }> {
  const before = await scanAllWorkspaceProbeEntries(client, env.workspaceId);
  const failures: string[] = [];
  for (const probe of before) {
    try {
      await client.timeEntries.delete({ workspaceId: env.workspaceId, timeEntryId: probe.id });
    } catch {
      failures.push(`${probe.userId}/${probe.id}`);
    }
  }
  const remaining = await scanAllWorkspaceProbeEntries(client, env.workspaceId);
  if (failures.length > 0 || remaining.length > 0) {
    throw new Error(
      `live cleanup failed: ${failures.length} delete request(s) failed and ${remaining.length} RT-PROBE- entry or entries remain after the verification scan`,
    );
  }
  return { deleted: before.length };
}

export interface ProbeArtifactScan {
  readonly tagIds: readonly string[];
  readonly customFieldIds: readonly string[];
}

/** Finds non-entry artifacts provisioned by live rows. Both active and inactive shapes are read. */
export async function scanWorkspaceProbeArtifacts(
  client: ClockifyClient,
  workspaceId: string,
): Promise<ProbeArtifactScan> {
  const tagIds: string[] = [];
  for (const archived of [false, true]) {
    for (let page = 1; page <= CLEANUP_MAX_PAGES; page += 1) {
      const tags = await client.tags.list({ workspaceId, archived, page, "page-size": CLEANUP_PAGE_SIZE });
      for (const tag of tags) {
        if (tag.id && tag.name?.startsWith(RT_PROBE_PREFIX)) tagIds.push(tag.id);
      }
      if (tags.length < CLEANUP_PAGE_SIZE) break;
      if (page === CLEANUP_MAX_PAGES) throw new Error(`live cleanup exceeded ${CLEANUP_MAX_PAGES} tag pages`);
    }
  }

  const customFieldIds: string[] = [];
  for (const status of ["VISIBLE", "INVISIBLE", "INACTIVE"] as const) {
    for (let page = 1; page <= CLEANUP_MAX_PAGES; page += 1) {
      const fields = await client.customFields.listForWorkspace({
        workspaceId,
        status,
        page,
        "page-size": CLEANUP_PAGE_SIZE,
      });
      for (const field of fields) {
        if (field.id && field.name?.startsWith(RT_PROBE_PREFIX)) customFieldIds.push(field.id);
      }
      if (fields.length < CLEANUP_PAGE_SIZE) break;
      if (page === CLEANUP_MAX_PAGES) throw new Error(`live cleanup exceeded ${CLEANUP_MAX_PAGES} custom-field pages`);
    }
  }
  return { tagIds: [...new Set(tagIds)], customFieldIds: [...new Set(customFieldIds)] };
}

/** Release teardown for every RT-PROBE artifact, followed by a bounded verification scan. */
export async function cleanupAllWorkspaceProbeArtifacts(
  env: LiveEnv,
  client: ClockifyClient = buildLiveRestClient(env),
): Promise<{ readonly entries: number; readonly tags: number; readonly customFields: number }> {
  const [entries, artifacts] = await Promise.all([
    scanAllWorkspaceProbeEntries(client, env.workspaceId),
    scanWorkspaceProbeArtifacts(client, env.workspaceId),
  ]);
  const steps: LiveCleanupStep[] = [
    ...entries.map((entry) => ({
      label: `entry ${entry.userId}/${entry.id}`,
      run: () => client.timeEntries.delete({ workspaceId: env.workspaceId, timeEntryId: entry.id }),
    })),
    ...artifacts.tagIds.map((tagId) => ({
      label: `tag ${tagId}`,
      run: () => client.tags.delete({ workspaceId: env.workspaceId, tagId }),
    })),
    ...artifacts.customFieldIds.map((customFieldId) => ({
      label: `custom field ${customFieldId}`,
      run: () => client.customFields.deleteForWorkspace({ workspaceId: env.workspaceId, customFieldId }),
    })),
  ];
  const failures: string[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch {
      failures.push(step.label);
    }
  }
  const [remainingEntries, remainingArtifacts] = await Promise.all([
    scanAllWorkspaceProbeEntries(client, env.workspaceId),
    scanWorkspaceProbeArtifacts(client, env.workspaceId),
  ]);
  if (
    failures.length > 0 ||
    remainingEntries.length > 0 ||
    remainingArtifacts.tagIds.length > 0 ||
    remainingArtifacts.customFieldIds.length > 0
  ) {
    throw new Error(
      `live cleanup failed: ${failures.length} delete request(s) failed; ${remainingEntries.length} RT-PROBE- entry or entries, ${remainingArtifacts.tagIds.length} tag(s), and ${remainingArtifacts.customFieldIds.length} custom field(s) remain`,
    );
  }
  return { entries: entries.length, tags: artifacts.tagIds.length, customFields: artifacts.customFieldIds.length };
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
    clockifyParentOrigin: DEVELOPER_PARENT_ORIGIN,
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
  return ingestEntry(harness.server.db, {
    id: input.id,
    scope: liveScope(harness.env),
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
