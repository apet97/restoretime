// CT-01..CT-05 (docs/13). Sanitized webhook-campaign fixtures normalize exactly as documented.
// Fixture provenance: copied from
// ~/Downloads/api-testing-restoration/time-entry-deleted-webhook/sanitized-payloads/ (see
// implementation/reports/PASS-02.md for the sanitization check).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { guardDeletedEntryPayload, normalizeDeletedEntry } from "../../src/ingest/deleted-entry.js";

const FIXTURES_DIR = fileURLToPath(new URL("../fixtures/webhook/", import.meta.url));

function load(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf8"));
}

function normalize(name: string) {
  const guarded = guardDeletedEntryPayload(load(name));
  if (!guarded.ok) throw new Error(`fixture ${name} failed the guard: ${guarded.reason}`);
  return normalizeDeletedEntry(guarded.payload);
}

describe("CT-01 S1 baseline fixture", () => {
  it("normalizes to the expected DeletedTimeEntry", () => {
    const entry = normalize("s1_baseline_deleted.json");
    expect(entry.entryId).toBe("ID_001");
    expect(entry.workspaceId).toBe("WSID");
    expect(entry.ownerId).toBe("UID1");
    expect(entry.description).toBe("DSWH1_baseline");
    expect(entry.billable).toBe(false);
    expect(entry.projectId).toBe("PROJ_A");
    expect(entry.taskId).toBeNull();
    expect(entry.tags).toEqual([]);
    expect(entry.wasRunning).toBe(false);
    expect(entry.start).toBe("2026-08-07T22:32:00Z");
    expect(entry.end).toBe("2026-08-07T23:02:00Z");
  });
});

describe("CT-02 S12 update->delete fixture", () => {
  it("carries the final (v2) values after normalization", () => {
    const entry = normalize("ENTRY_DSWH2_S12_updated.json");
    expect(entry.description).toBe("DSWH2_S12c_v2_updated");
    expect(entry.start).toBe("2026-08-09T00:05:00Z");
    expect(entry.end).toBe("2026-08-09T00:20:00Z");
    expect(entry.billable).toBe(true);
  });
});

describe("CT-03 S4 description-variant fixtures", () => {
  const cases: Array<[string, string]> = [
    ["ENTRY_DSWH2_S4_ascii.json", undefined as unknown as string],
    ["ENTRY_DSWH2_S4_empty.json", ""],
    ["ENTRY_DSWH2_S4_html.json", undefined as unknown as string],
    ["ENTRY_DSWH2_S4_newlines.json", undefined as unknown as string],
    ["ENTRY_DSWH2_S4_tabs.json", undefined as unknown as string],
    ["ENTRY_DSWH2_S4_unicode.json", undefined as unknown as string],
  ];

  it.each(cases)("round-trips %s byte-exact", (file) => {
    const raw = load(file) as { description: string };
    const entry = normalize(file);
    expect(entry.description).toBe(raw.description);
  });

  it("preserves the empty description exactly", () => {
    const entry = normalize("ENTRY_DSWH2_S4_empty.json");
    expect(entry.description).toBe("");
  });

  it("preserves newlines and tabs byte-exact", () => {
    const newlineEntry = normalize("ENTRY_DSWH2_S4_newlines.json");
    expect(newlineEntry.description).toContain("\n");
    const tabEntry = normalize("ENTRY_DSWH2_S4_tabs.json");
    expect(tabEntry.description).toContain("\t");
  });
});

describe("CT-04 running fixture", () => {
  it("tiebreak_run1 (currentlyRunning:true) -> wasRunning:true, end:null", () => {
    const entry = normalize("ENTRY_DSWH2_tiebreak_run1.deleted.json");
    expect(entry.wasRunning).toBe(true);
    expect(entry.end).toBeNull();
    expect(entry.start).toBe("2026-08-07T22:46:18Z");
  });

  it("DSWH1 s9 (auto-stopped, W12) -> wasRunning:false despite the 'running' fixture name", () => {
    // Deviation from a literal docs/13 reading, recorded in PASS-02.md: this file is the
    // auto-stopped artifact the campaign captured, not a genuinely-running delete (W12). It
    // normalizes as a normal stopped entry, which is itself the behavior W12 documents.
    const entry = normalize("s9_running_deleted.json");
    expect(entry.wasRunning).toBe(false);
    expect(entry.end).not.toBeNull();
  });
});

describe("CT-05 S2 maximum-info fixture", () => {
  it("captures project/task/tags/CF fields", () => {
    const entry = normalize("ENTRY_DSWH2_S2.json");
    expect(entry.projectId).toBe("PROJ_DSWH2_MAX");
    expect(entry.projectName).toBe("DSWH2_proj_max");
    expect(entry.clientName).toBe("DSWH2_client_max");
    expect(entry.taskId).toBe("TASK_DSWH2");
    expect(entry.taskName).toBe("DSWH2_task_max");
    expect(entry.tags).toEqual([
      { id: "TAG_A", name: "DSWH2_tag_A" },
      { id: "TAG_B", name: "DSWH2_tag_B" },
      { id: "TAG_UNI", name: "DSWH2_tag_Unicode_\u{1F680}" },
    ]);
    expect(entry.customFieldValues.length).toBe(9);
    const test123 = entry.customFieldValues.find((v) => v.name === "test123");
    expect(test123?.value).toBe("1323123");
    const dropdown = entry.customFieldValues.find((v) => v.name === "DSR9_CF_Dropdown");
    expect(dropdown?.value).toBe("DSR9_Opt2");
  });
});
