// UT-P01..UT-P16 (docs/13, docs/07 §2-§5). Pure decision-rule tests: no I/O, fixed WorkspaceState
// inputs standing in for the six-lookup fetch (src/clockify/preflight-data.ts covers the I/O side
// separately).
import { describe, expect, it } from "vitest";
import { runPreflight, type PreflightInput, type WorkspaceState } from "../../src/domain/preflight.js";
import type { DeletedTimeEntry, PreflightChoices, Viewer } from "../../src/domain/entry.js";

function source(overrides: Partial<DeletedTimeEntry> = {}): DeletedTimeEntry {
  return {
    workspaceId: "ws-1",
    entryId: "entry-a",
    ownerId: "user-1",
    ownerName: "User One",
    description: "hello",
    billable: true,
    start: "2026-08-08T10:00:00Z",
    end: "2026-08-08T11:00:00Z",
    wasRunning: false,
    type: "REGULAR",
    timeZone: "UTC",
    projectId: "proj-1",
    projectName: "Project One",
    clientName: "Client A",
    taskId: "task-1",
    taskName: "Task One",
    tags: [{ id: "tag-1", name: "Tag One" }],
    customFieldValues: [],
    ...overrides,
  };
}

function workspace(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    forceProjects: false,
    forceTasks: false,
    forceTags: false,
    forceDescription: false,
    onlyAdminsCanChangeBillableStatus: false,
    defaultBillableProjects: false,
    impliedBillable: true,
    timeTrackingMode: "DEFAULT",
    lockTimeEntries: null,
    automaticLockSet: false,
    ownerStatus: "ACTIVE",
    effectiveProject: { id: "proj-1", archived: false },
    effectiveTask: { id: "task-1", status: "ACTIVE" },
    currentTags: new Map([["tag-1", { id: "tag-1", archived: false }]]),
    customFields: [],
    ...overrides,
  };
}

const ADMIN_VIEWER: Viewer = { userId: "admin-1", workspaceId: "ws-1", workspaceRole: "admin" };
const OWNER_VIEWER: Viewer = { userId: "user-1", workspaceId: "ws-1", workspaceRole: "member" };

function preflight(opts: {
  source?: DeletedTimeEntry;
  viewer?: Viewer;
  choices?: PreflightChoices;
  workspace?: WorkspaceState;
  now?: Date;
}) {
  const input: PreflightInput = {
    source: opts.source ?? source(),
    viewer: opts.viewer ?? OWNER_VIEWER,
    choices: opts.choices ?? {},
    workspace: opts.workspace ?? workspace(),
    now: opts.now ?? new Date("2026-08-08T11:30:00Z"),
  };
  return runPreflight(input);
}

function ruleIds(items: readonly { ruleId: string }[]): string[] {
  return items.map((i) => i.ruleId);
}

describe("UT-P01 P-RUN / P-RUN-END", () => {
  it("a running source with no runningMode choice -> ACTION_REQUIRED with the single-timer warning", () => {
    const result = preflight({ source: source({ wasRunning: true, end: null }) });
    expect(ruleIds(result.actionRequired)).toContain("P-RUN");
    const item = result.actionRequired.find((a) => a.ruleId === "P-RUN");
    expect(item?.message).toMatch(/running timer/i);
    expect(item?.message).toMatch(/replaces any timer/i);
  });

  it("completed mode with completedEnd <= start -> ACTION_REQUIRED", () => {
    const result = preflight({
      source: source({ wasRunning: true, end: null }),
      choices: { runningMode: "completed", completedEnd: "2026-08-08T09:59:00Z" },
    });
    expect(ruleIds(result.actionRequired)).toContain("P-RUN-END");
  });

  it("completed mode with a valid completedEnd resolves and adjusts fidelity", () => {
    const result = preflight({
      source: source({ wasRunning: true, end: null }),
      choices: { runningMode: "completed", completedEnd: "2026-08-08T12:00:00Z" },
    });
    expect(result.actionRequired).toHaveLength(0);
    expect(result.plannedRequest.end).toBe("2026-08-08T12:00:00Z");
    expect(result.fidelity).toBe("ADJUSTED");
  });

  it("running mode preserves the source state with FULL fidelity, no end sent", () => {
    const result = preflight({
      source: source({ wasRunning: true, end: null }),
      choices: { runningMode: "running" },
    });
    expect(result.plannedRequest.end).toBeUndefined();
    expect(result.fidelity).toBe("FULL");
  });
});

describe("UT-P02 P-PROJ-GONE", () => {
  it("source project 404, no choice -> ACTION_REQUIRED replacement picker", () => {
    const result = preflight({ workspace: workspace({ effectiveProject: null }) });
    expect(ruleIds(result.actionRequired)).toContain("P-PROJ-GONE");
  });

  it("offers 'no project' only when !forceProjects", () => {
    const notForced = preflight({ workspace: workspace({ effectiveProject: null, forceProjects: false }) });
    const item = notForced.actionRequired.find((a) => a.ruleId === "P-PROJ-GONE");
    expect(item?.options).toContain("remove");

    const forced = preflight({ workspace: workspace({ effectiveProject: null, forceProjects: true }) });
    const forcedItem = forced.actionRequired.find((a) => a.ruleId === "P-PROJ-GONE");
    expect(forcedItem?.options).toBeUndefined();
  });
});

describe("UT-P03 P-PROJ-ARCH", () => {
  it("effective project archived -> warning ARCHIVED_PROJECT, never a blocker", () => {
    const result = preflight({ workspace: workspace({ effectiveProject: { id: "proj-1", archived: true } }) });
    expect(result.warnings.some((w) => w.code === "ARCHIVED_PROJECT")).toBe(true);
    expect(result.blockers).toHaveLength(0);
  });
});

describe("UT-P04 P-TASK-GONE / P-TASK-CTX", () => {
  it("task missing on the effective project -> ACTION_REQUIRED", () => {
    const result = preflight({ workspace: workspace({ effectiveTask: null }) });
    expect(ruleIds(result.actionRequired)).toContain("P-TASK-GONE");
  });

  it("task status !== ACTIVE -> ACTION_REQUIRED", () => {
    const result = preflight({ workspace: workspace({ effectiveTask: { id: "task-1", status: "DONE" } }) });
    expect(ruleIds(result.actionRequired)).toContain("P-TASK-GONE");
  });

  it("project substituted while a source task is set -> the source task cannot follow (treated as P-TASK-CTX/dropped, no ACTION_REQUIRED forced when the new project has no matching task selection)", () => {
    const result = preflight({
      choices: { projectId: "proj-2" },
      workspace: workspace({ effectiveProject: { id: "proj-2", archived: false }, effectiveTask: undefined }),
    });
    expect(result.plannedRequest.taskId).toBeUndefined();
    expect(result.fidelity).toBe("ADJUSTED");
  });
});

describe("UT-P05 P-TAG-GONE / P-TAG-REQ", () => {
  it("a missing source tag -> per-tag ACTION_REQUIRED", () => {
    const result = preflight({ workspace: workspace({ currentTags: new Map() }) });
    expect(ruleIds(result.actionRequired)).toContain("P-TAG-GONE");
  });

  it("all tags dropped, forceTags on, no addTagIds -> ACTION_REQUIRED", () => {
    const result = preflight({
      choices: { dropTagIds: ["tag-1"] },
      workspace: workspace({ forceTags: true }),
    });
    expect(ruleIds(result.actionRequired)).toContain("P-TAG-REQ");
  });

  it("all tags dropped, forceTags on, addTagIds provided -> no P-TAG-REQ", () => {
    const result = preflight({
      choices: { dropTagIds: ["tag-1"], addTagIds: ["tag-2"] },
      workspace: workspace({ forceTags: true, currentTags: new Map([["tag-2", { id: "tag-2", archived: false }]]) }),
    });
    expect(ruleIds(result.actionRequired)).not.toContain("P-TAG-REQ");
    expect(result.plannedRequest.tagIds).toEqual(["tag-2"]);
  });
});

describe("UT-P06 P-TAG-ARCH", () => {
  it("an archived tag -> ACTION_REQUIRED, not a warning", () => {
    const result = preflight({ workspace: workspace({ currentTags: new Map([["tag-1", { id: "tag-1", archived: true }]]) }) });
    expect(ruleIds(result.actionRequired)).toContain("P-TAG-ARCH");
    expect(result.warnings.some((w) => w.ruleId === "P-TAG-ARCH")).toBe(false);
  });
});

describe("UT-P07 P-OWNER", () => {
  it("owner absent from users.list -> blocker OWNER_UNAVAILABLE, no owner picker offered", () => {
    const result = preflight({ workspace: workspace({ ownerStatus: null }) });
    expect(result.blockers.some((b) => b.code === "OWNER_UNAVAILABLE")).toBe(true);
    expect(result.fidelity).toBe("IMPOSSIBLE");
  });

  it("owner membership status !== ACTIVE -> blocker", () => {
    const result = preflight({ workspace: workspace({ ownerStatus: "DECLINED" }) });
    expect(result.blockers.some((b) => b.code === "OWNER_UNAVAILABLE")).toBe(true);
  });
});

describe("UT-P08 P-PROJ-REQ", () => {
  it("forceProjects on, no effective project, completed mode -> ACTION_REQUIRED", () => {
    const result = preflight({
      source: source({ projectId: null }),
      workspace: workspace({ forceProjects: true, effectiveProject: undefined }),
    });
    expect(ruleIds(result.actionRequired)).toContain("P-PROJ-REQ");
  });

  it("running mode resolves it (R4) — no P-PROJ-REQ", () => {
    const result = preflight({
      source: source({ projectId: null, wasRunning: true, end: null }),
      choices: { runningMode: "running" },
      workspace: workspace({ forceProjects: true, effectiveProject: undefined }),
    });
    expect(ruleIds(result.actionRequired)).not.toContain("P-PROJ-REQ");
  });
});

describe("UT-P09 P-DESC", () => {
  it("forceDescription on, empty effective description -> ACTION_REQUIRED", () => {
    const result = preflight({ source: source({ description: "" }), workspace: workspace({ forceDescription: true }) });
    expect(ruleIds(result.actionRequired)).toContain("P-DESC");
  });

  it("forceDescription on, non-empty description -> no ACTION_REQUIRED", () => {
    const result = preflight({ workspace: workspace({ forceDescription: true }) });
    expect(ruleIds(result.actionRequired)).not.toContain("P-DESC");
  });
});

describe("UT-P10 P-BILL", () => {
  it("onlyAdminsCanChangeBillableStatus set, viewer not admin, billable differs from implied -> warning", () => {
    const result = preflight({
      source: source({ billable: false }),
      workspace: workspace({ onlyAdminsCanChangeBillableStatus: true, impliedBillable: true }),
    });
    expect(result.warnings.some((w) => w.code === "BILLABLE_MAY_CHANGE")).toBe(true);
  });

  it("admin viewer -> no P-BILL warning even with the same settings", () => {
    const result = preflight({
      source: source({ billable: false }),
      viewer: ADMIN_VIEWER,
      workspace: workspace({ onlyAdminsCanChangeBillableStatus: true, impliedBillable: true }),
    });
    expect(result.warnings.some((w) => w.code === "BILLABLE_MAY_CHANGE")).toBe(false);
  });

  it("neither setting present -> no warning even if billable differs", () => {
    const result = preflight({
      source: source({ billable: false }),
      workspace: workspace({ onlyAdminsCanChangeBillableStatus: false, defaultBillableProjects: false, impliedBillable: true }),
    });
    expect(result.warnings.some((w) => w.code === "BILLABLE_MAY_CHANGE")).toBe(false);
  });
});

describe("UT-P11 P-LOCK / P-LOCK-REG", () => {
  it("admin viewer -> the rule does not apply regardless of lock settings or age", () => {
    const result = preflight({
      viewer: ADMIN_VIEWER,
      workspace: workspace({ lockTimeEntries: "2026-08-01" }),
      now: new Date("2026-09-01T00:00:00Z"),
    });
    expect(result.warnings.some((w) => w.ruleId === "P-LOCK-REG")).toBe(false);
  });

  it("regular viewer, a lock setting present, source.start >= 24h old -> warning", () => {
    const result = preflight({
      workspace: workspace({ lockTimeEntries: "2026-08-01" }),
      now: new Date("2026-08-09T10:00:01Z"), // > 24h after 2026-08-08T10:00:00Z
    });
    expect(result.warnings.some((w) => w.code === "PERIOD_MAY_BE_LOCKED")).toBe(true);
  });

  it("regular viewer, entry younger than 24h -> no warning, never blocks", () => {
    const result = preflight({
      workspace: workspace({ lockTimeEntries: "2026-08-01" }),
      now: new Date("2026-08-08T11:30:00Z"), // 1.5h after start
    });
    expect(result.warnings.some((w) => w.ruleId === "P-LOCK-REG")).toBe(false);
    expect(result.blockers).toHaveLength(0);
  });

  it("no lock setting present -> no warning regardless of age", () => {
    const result = preflight({
      workspace: workspace({ lockTimeEntries: null, automaticLockSet: false }),
      now: new Date("2026-09-01T00:00:00Z"),
    });
    expect(result.warnings.some((w) => w.ruleId === "P-LOCK-REG")).toBe(false);
  });
});

describe("UT-P12 P-CF-GONE", () => {
  it("field absent from the workspace list -> warning CF_FIELD_GONE, value not sent, fidelity PARTIAL", () => {
    const result = preflight({
      source: source({ customFieldValues: [{ customFieldId: "cf-1", name: "Field", value: "x" }] }),
      workspace: workspace({ customFields: [] }),
    });
    expect(result.warnings.some((w) => w.code === "CF_FIELD_GONE")).toBe(true);
    expect(result.plannedRequest.customFields).toBeUndefined();
    expect(result.fidelity).toBe("PARTIAL");
  });

  it("field present but status === INACTIVE -> same treatment", () => {
    const result = preflight({
      source: source({ customFieldValues: [{ customFieldId: "cf-1", name: "Field", value: "x" }] }),
      workspace: workspace({
        customFields: [{ id: "cf-1", name: "Field cf-1", active: false, required: false, type: "TXT", allowedValues: null, defaultValue: null }],
      }),
    });
    expect(result.warnings.some((w) => w.code === "CF_FIELD_GONE")).toBe(true);
    expect(result.fidelity).toBe("PARTIAL");
  });
});

describe("UT-P14 P-TYPE", () => {
  it("non-REGULAR source -> blocker TYPE_NOT_SUPPORTED", () => {
    const result = preflight({ source: source({ type: "BREAK" }) });
    expect(result.blockers.some((b) => b.code === "TYPE_NOT_SUPPORTED")).toBe(true);
    expect(result.fidelity).toBe("IMPOSSIBLE");
  });
});

describe("UT-P15 P-TIMER", () => {
  it("STOPWATCH_ONLY, plan sends an end, viewer not admin -> blocker TIMER_REQUIRED with admin handoff", () => {
    const result = preflight({ workspace: workspace({ timeTrackingMode: "STOPWATCH_ONLY" }) });
    const blocker = result.blockers.find((b) => b.code === "TIMER_REQUIRED");
    expect(blocker).toBeDefined();
    expect(blocker?.message).toMatch(/admin/i);
  });

  it("admin viewer -> no blocker even under STOPWATCH_ONLY", () => {
    const result = preflight({ viewer: ADMIN_VIEWER, workspace: workspace({ timeTrackingMode: "STOPWATCH_ONLY" }) });
    expect(result.blockers.some((b) => b.code === "TIMER_REQUIRED")).toBe(false);
  });

  it("running-mode plan (no end) is unaffected", () => {
    const result = preflight({
      source: source({ wasRunning: true, end: null }),
      choices: { runningMode: "running" },
      workspace: workspace({ timeTrackingMode: "STOPWATCH_ONLY" }),
    });
    expect(result.blockers.some((b) => b.code === "TIMER_REQUIRED")).toBe(false);
  });
});

describe("UT-P16 P-CF-KEEP / P-CF-WRITE / P-CF-OPT / P-CF-REQ", () => {
  it("P-CF-KEEP: value equal to workspaceDefaultValue -> nothing sent, no warning", () => {
    const result = preflight({
      source: source({ customFieldValues: [{ customFieldId: "cf-1", name: "Field", value: "default" }] }),
      workspace: workspace({
        customFields: [{ id: "cf-1", name: "Field cf-1", active: true, required: false, type: "TXT", allowedValues: null, defaultValue: "default" }],
      }),
    });
    expect(result.plannedRequest.customFields).toBeUndefined();
    expect(result.fidelity).toBe("FULL");
  });

  it("P-CF-WRITE: value differs from the default -> one customFields item, key is exactly 'customFields'", () => {
    const result = preflight({
      source: source({ customFieldValues: [{ customFieldId: "cf-1", name: "Field", value: "custom" }] }),
      workspace: workspace({
        customFields: [{ id: "cf-1", name: "Field cf-1", active: true, required: false, type: "TXT", allowedValues: null, defaultValue: "default" }],
      }),
    });
    expect(result.plannedRequest.customFields).toEqual([{ customFieldId: "cf-1", sourceType: "WORKSPACE", value: "custom" }]);
    expect("customFieldValues" in result.plannedRequest).toBe(false);
    // A source value preserved through the write path does not downgrade fidelity (docs/07 §10).
    expect(result.fidelity).toBe("FULL");
  });

  it("numeric strings normalize for the default-equality check (R5)", () => {
    const result = preflight({
      source: source({ customFieldValues: [{ customFieldId: "cf-1", name: "Field", value: "777.5" }] }),
      workspace: workspace({
        customFields: [{ id: "cf-1", name: "Field cf-1", active: true, required: false, type: "NUMBER", allowedValues: null, defaultValue: 777.5 }],
      }),
    });
    expect(result.plannedRequest.customFields).toBeUndefined();
  });

  it("P-CF-OPT: dropdown value outside allowedValues, no choice -> three-choice ACTION_REQUIRED", () => {
    const result = preflight({
      source: source({ customFieldValues: [{ customFieldId: "cf-1", name: "Field", value: "STALE_OPTION" }] }),
      workspace: workspace({
        customFields: [{ id: "cf-1", name: "Field cf-1", active: true, required: false, type: "DROPDOWN_SINGLE", allowedValues: ["A", "B"], defaultValue: "A" }],
      }),
    });
    const item = result.actionRequired.find((a) => a.ruleId === "P-CF-OPT");
    expect(item).toBeDefined();
    expect(item?.options).toEqual(["replace", "keep", "drop"]);
  });

  // docs/07 §10 reserves ADJUSTED for an input "that changes values". The P-CF-OPT "keep the
  // original value" choice re-sends the source value byte for byte, so nothing is substituted and
  // nothing is lost: the plan is FULL with a CF_OPTION_STALE warning. (This assertion previously
  // read ADJUSTED; that pinned a behavior §10 does not describe.)
  it("P-CF-OPT resolved by keeping the stale value -> warning CF_OPTION_STALE, value preserved, FULL", () => {
    const result = preflight({
      source: source({ customFieldValues: [{ customFieldId: "cf-1", name: "Field", value: "STALE_OPTION" }] }),
      choices: { customFieldInputs: [{ customFieldId: "cf-1", value: "STALE_OPTION" }] },
      workspace: workspace({
        customFields: [{ id: "cf-1", name: "Field cf-1", active: true, required: false, type: "DROPDOWN_SINGLE", allowedValues: ["A", "B"], defaultValue: "A" }],
      }),
    });
    expect(result.warnings.some((w) => w.code === "CF_OPTION_STALE")).toBe(true);
    expect(result.plannedRequest.customFields).toEqual([{ customFieldId: "cf-1", sourceType: "WORKSPACE", value: "STALE_OPTION" }]);
    expect(result.fidelity).toBe("FULL");
  });

  it("P-CF-OPT resolved by picking a different current option -> ADJUSTED", () => {
    const result = preflight({
      source: source({ customFieldValues: [{ customFieldId: "cf-1", name: "Field", value: "STALE_OPTION" }] }),
      choices: { customFieldInputs: [{ customFieldId: "cf-1", value: "B" }] },
      workspace: workspace({
        customFields: [{ id: "cf-1", name: "Field cf-1", active: true, required: false, type: "DROPDOWN_SINGLE", allowedValues: ["A", "B"], defaultValue: "A" }],
      }),
    });
    expect(result.plannedRequest.customFields).toEqual([{ customFieldId: "cf-1", sourceType: "WORKSPACE", value: "B" }]);
    expect(result.fidelity).toBe("ADJUSTED");
  });

  it("P-CF-OPT on a DROPDOWN_MULTIPLE with one stale element -> ACTION_REQUIRED", () => {
    const result = preflight({
      source: source({ customFieldValues: [{ customFieldId: "cf-1", name: "Field", value: ["A", "GONE"] }] }),
      workspace: workspace({
        customFields: [{ id: "cf-1", name: "Field cf-1", active: true, required: false, type: "DROPDOWN_MULTIPLE", allowedValues: ["A", "B"], defaultValue: null }],
      }),
    });
    expect(result.actionRequired.some((a) => a.ruleId === "P-CF-OPT")).toBe(true);
  });

  it("P-CF-WRITE rejects a non-numeric value for a NUMBER field instead of letting the create fail", () => {
    const result = preflight({
      source: source({ customFieldValues: [{ customFieldId: "cf-1", name: "Field", value: "not-a-number" }] }),
      workspace: workspace({
        customFields: [{ id: "cf-1", name: "Field cf-1", active: true, required: false, type: "NUMBER", allowedValues: null, defaultValue: null }],
      }),
    });
    expect(result.actionRequired.some((a) => a.message.includes("needs a number"))).toBe(true);
    expect(result.plannedRequest.customFields).toBeUndefined();
  });

  it("P-CF-OPT dropped -> warning, PARTIAL", () => {
    const result = preflight({
      source: source({ customFieldValues: [{ customFieldId: "cf-1", name: "Field", value: "STALE_OPTION" }] }),
      choices: { dropCustomFieldIds: ["cf-1"] },
      workspace: workspace({
        customFields: [{ id: "cf-1", name: "Field cf-1", active: true, required: false, type: "DROPDOWN_SINGLE", allowedValues: ["A", "B"], defaultValue: "A" }],
      }),
    });
    expect(result.plannedRequest.customFields).toBeUndefined();
    expect(result.fidelity).toBe("PARTIAL");
  });

  it("P-CF-REQ: required field with no usable value -> ACTION_REQUIRED after source -> default resolution fails", () => {
    const result = preflight({
      source: source({ customFieldValues: [] }),
      workspace: workspace({
        customFields: [{ id: "cf-1", name: "Field cf-1", active: true, required: true, type: "TXT", allowedValues: null, defaultValue: null }],
      }),
    });
    expect(ruleIds(result.actionRequired)).toContain("P-CF-REQ");
  });

  it("P-CF-REQ resolved via workspaceDefaultValue when the source had none — no ACTION_REQUIRED, fidelity-neutral", () => {
    const result = preflight({
      source: source({ customFieldValues: [] }),
      workspace: workspace({
        customFields: [{ id: "cf-1", name: "Field cf-1", active: true, required: true, type: "TXT", allowedValues: null, defaultValue: "workspace-default" }],
      }),
    });
    expect(ruleIds(result.actionRequired)).not.toContain("P-CF-REQ");
    expect(result.fidelity).toBe("FULL");
  });

  it("P-CF-REQ resolved via explicit user input -> ADJUSTED", () => {
    const result = preflight({
      source: source({ customFieldValues: [] }),
      choices: { customFieldInputs: [{ customFieldId: "cf-1", value: "user-entered" }] },
      workspace: workspace({
        customFields: [{ id: "cf-1", name: "Field cf-1", active: true, required: true, type: "TXT", allowedValues: null, defaultValue: null }],
      }),
    });
    expect(ruleIds(result.actionRequired)).not.toContain("P-CF-REQ");
    expect(result.plannedRequest.customFields).toEqual([{ customFieldId: "cf-1", sourceType: "WORKSPACE", value: "user-entered" }]);
    expect(result.fidelity).toBe("ADJUSTED");
  });

  it("customFields key is omitted entirely when empty", () => {
    const result = preflight({});
    expect("customFields" in result.plannedRequest).toBe(false);
  });
});

describe("P-PERM defense in depth", () => {
  it("a non-admin viewer who is not the owner -> blocker NOT_PERMITTED", () => {
    const result = preflight({ viewer: { userId: "user-2", workspaceId: "ws-1", workspaceRole: "member" } });
    expect(result.blockers.some((b) => b.code === "NOT_PERMITTED")).toBe(true);
  });
});

// docs/07 §10: ADJUSTED covers "≥1 explicit user substitution/drop/input that changes values
// (project, task, …)". A removal is a drop, so labelling it FULL would tell the user nothing
// changed while the new entry loses the project the deleted one had.
describe("fidelity of explicit removals (docs/07 §10)", () => {
  it("removing the source project is ADJUSTED, not FULL", () => {
    const result = preflight({
      source: source({ projectId: "proj-1" }),
      choices: { projectId: null },
      workspace: workspace({ forceProjects: false, effectiveProject: null }),
    });
    expect(result.blockers).toEqual([]);
    expect(result.fidelity).toBe("ADJUSTED");
  });

  it("removing the source task is ADJUSTED, not FULL", () => {
    const result = preflight({
      source: source({ projectId: "proj-1", taskId: "task-1" }),
      choices: { taskId: null },
      workspace: workspace({ effectiveProject: { id: "proj-1", archived: false } }),
    });
    expect(result.blockers).toEqual([]);
    expect(result.fidelity).toBe("ADJUSTED");
  });

  it("a plan with no substitutions and no drops stays FULL", () => {
    const result = preflight({
      source: source({ projectId: "proj-1" }),
      workspace: workspace({ effectiveProject: { id: "proj-1", archived: false } }),
    });
    expect(result.fidelity).toBe("FULL");
  });
});
