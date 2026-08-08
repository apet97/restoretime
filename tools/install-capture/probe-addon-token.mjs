// R11 probe: prove the addon-token REST success path on the installed workspace, then delete the
// probe entry (cleanup) so the deletion fires a live addon-mode TIME_ENTRY_DELETED webhook at
// the capture server (W11 addon-mode). Run: node probe-addon-token.mjs
//
// Steps: load installation (decrypt) → resolve apiUrl → users.list (status ALL) → pick a target
// user (another ACTIVE user when one exists, else the installer) → createForUser 5-minute entry
// → timeEntries.get → timeEntries.delete. Prints one JSON line per step. Never prints the token.

import { createClockifyClient, getErrorCode } from "clockify-sdk-ts-115";
import { resolveClockifyApiBaseUrl } from "@apet97/clockify-addon-sdk/clockify";
import { installations } from "./store.mjs";

const [workspaceId, addonId] = (process.env.RT_INSTALLATION ?? "").split(":");
if (!workspaceId || !addonId) {
  console.error('Set RT_INSTALLATION="<workspaceId>:<addonId>" (see the capture log).');
  process.exit(1);
}

const step = (name, data) => console.log(JSON.stringify({ step: name, ...data }));
const installation = await installations.load(workspaceId, addonId);
if (!installation) {
  console.error("No captured installation for that key. Is the addon installed?");
  process.exit(1);
}
const baseUrl = resolveClockifyApiBaseUrl({ apiUrl: installation.apiUrl });
step("installation", { workspaceId, addonId, apiUrl: installation.apiUrl, baseUrl, asUser: installation.asUser });

const client = createClockifyClient({
  addonToken: installation.authToken,
  baseUrl,
  timeoutInSeconds: 30,
});

// USER_READ with the addon token; the exact request shape the product uses (docs/03 note 1).
const users = await client.users.list({
  workspaceId,
  status: "ALL",
  "include-roles": false,
  "page-size": 200,
});
const active = users.filter((u) => u.status === "ACTIVE");
const target = active.find((u) => u.id !== installation.asUser) ?? active[0];
if (!target) throw new Error("No ACTIVE user found in the workspace.");
step("users", {
  total: users.length,
  active: active.length,
  targetUserId: target.id,
  targetIsOtherUser: target.id !== installation.asUser,
});

// PROJECT_READ with the addon token; the dev workspace has forceProjects on (R4), so the create
// must carry a projectId.
const projects = await client.projects.list({ workspaceId, "page-size": 200 });
const project = projects.find((p) => !p.archived);
step("projects", { total: projects.length, using: project?.id ?? null });
if (!project) throw new Error("No non-archived project in the workspace.");

// TIME_ENTRY_WRITE with the addon token: the exact recreation route (ADR-004).
const start = new Date(Date.now() - 60 * 60 * 1000);
const end = new Date(start.getTime() + 5 * 60 * 1000);
let created;
try {
  created = await client.timeEntries.createForUser({
    workspaceId,
    userId: target.id,
    start: start.toISOString(),
    end: end.toISOString(),
    description: `RT-PROBE-R11 ${start.toISOString()} (safe to delete)`,
    billable: false,
    projectId: project.id,
  });
} catch (err) {
  step("createForUser", { ok: false, status: err?.statusCode, code: getErrorCode(err), message: String(err?.message ?? err) });
  throw err;
}
step("createForUser", { ok: true, id: created.id, userId: created.userId, type: created.type });

// TIME_ENTRY_READ.
const fetched = await client.timeEntries.get({ workspaceId, timeEntryId: created.id });
step("get", { ok: fetched.id === created.id, description: fetched.description });

// Cleanup: delete the probe entry. This deletion must fire TIME_ENTRY_DELETED at the capture
// server — the live addon-mode webhook check (W11).
await client.timeEntries.delete({ workspaceId, timeEntryId: created.id });
step("delete", { ok: true, id: created.id, note: "watch the capture server log for WEBHOOK_CAPTURED" });
