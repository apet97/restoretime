// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionExpiredError } from "../../src/ui/api.js";
import { createUiSessionState, type Ctx } from "../../src/ui/state.js";
import type { DeletedTimeEntry, ListResponse } from "../../src/ui/types.js";
import { renderList } from "../../src/ui/views/list.js";
import { renderResolutionWidgets } from "../../src/ui/views/resolution-widgets.js";

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function source(): DeletedTimeEntry {
  return {
    workspaceId: "ws-1",
    entryId: "entry-1",
    ownerId: "user-1",
    ownerName: "Ana Markovic",
    description: "Investigation",
    billable: false,
    start: "2026-08-07T09:00:00Z",
    end: "2026-08-07T10:00:00Z",
    wasRunning: false,
    type: "REGULAR",
    timeZone: "UTC",
    projectId: "project-old",
    projectName: "Old project",
    clientName: null,
    taskId: null,
    taskName: null,
    tags: [],
    customFieldValues: [],
  };
}

function stubCtx(get: Ctx["api"]["get"]): Ctx {
  let navigationVersion = 1;
  const root = document.createElement("main");
  document.body.appendChild(root);
  return {
    root,
    api: { get, post: vi.fn(), mutate: vi.fn() },
    bridge: { subscribe: vi.fn(), refreshAddonToken: vi.fn(), navigate: vi.fn(), showToast: vi.fn() } as unknown as Ctx["bridge"],
    locale: "en-GB",
    isAdminRole: true,
    session: createUiSessionState(),
    getNavigationVersion: () => navigationVersion,
    navigate: vi.fn(() => {
      navigationVersion += 1;
    }),
    announce: vi.fn(),
    reload: vi.fn(),
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("background option requests", () => {
  it("does not append a deferred resolution option after navigation", async () => {
    const request = deferred<unknown>();
    const get = vi.fn(() => request.promise);
    const ctx = stubCtx(get);
    const rendered = renderResolutionWidgets(
      ctx,
      {},
      vi.fn(),
      [{ ruleId: "P-PROJ-GONE", message: "Select a current project.", options: ["substitute"] }],
      null,
      source(),
    );
    const select = rendered.querySelector<HTMLSelectElement>('select[aria-label="Replacement project"]');
    expect(select).not.toBeNull();

    ctx.navigate({ kind: "list" });
    request.resolve({ items: [{ id: "project-new", name: "New project" }] });
    await flushPromises();

    expect(Array.from(select?.options ?? []).map((option) => option.value)).toEqual([""]);
  });

  it("routes a current SessionExpiredError through the router", async () => {
    const get = vi.fn().mockRejectedValue(new SessionExpiredError());
    const ctx = stubCtx(get);

    renderResolutionWidgets(
      ctx,
      {},
      vi.fn(),
      [{ ruleId: "P-PROJ-GONE", message: "Select a current project.", options: ["substitute"] }],
      null,
      source(),
    );

    await vi.waitFor(
      () => expect(ctx.navigate).toHaveBeenCalledWith({ kind: "session-expired" }),
      { timeout: 200 },
    );
  });

  it("does not replace a newer view for a late SessionExpiredError", async () => {
    const request = deferred<unknown>();
    const ctx = stubCtx(vi.fn(() => request.promise));
    renderResolutionWidgets(
      ctx,
      {},
      vi.fn(),
      [{ ruleId: "P-PROJ-GONE", message: "Select a current project.", options: ["substitute"] }],
      null,
      source(),
    );

    ctx.navigate({ kind: "list" });
    request.reject(new SessionExpiredError());
    await flushPromises();

    expect(ctx.navigate).toHaveBeenCalledTimes(1);
    expect(ctx.navigate).toHaveBeenCalledWith({ kind: "list" });
  });

  it("binds each cached suggestion consumer to the view that requested it", async () => {
    const projectRequest = deferred<unknown>();
    const emptyList: ListResponse = {
      entries: [],
      clockifyUnavailable: false,
      disabled: false,
      broken: false,
      nextCursor: null,
    };
    const get = vi.fn((path: string, query?: Record<string, string>) => {
      if (path === "/api/entries") return Promise.resolve(emptyList);
      if (query?.kind === "projects") return projectRequest.promise;
      return Promise.resolve({ items: [] });
    }) as Ctx["api"]["get"];
    const ctx = stubCtx(get);

    renderList(ctx);
    await vi.waitFor(() => expect(ctx.root.textContent).toContain("Deleted time entries"));
    const firstList = ctx.root.querySelector<HTMLDataListElement>("#rt-project-names");
    expect(firstList).not.toBeNull();

    const apply = Array.from(ctx.root.querySelectorAll("button")).find((button) => button.textContent === "Apply filters");
    apply?.click();
    await vi.waitFor(() => {
      const current = ctx.root.querySelector<HTMLDataListElement>("#rt-project-names");
      expect(current).not.toBeNull();
      expect(current).not.toBe(firstList);
    });
    const currentList = ctx.root.querySelector<HTMLDataListElement>("#rt-project-names");

    projectRequest.resolve({ items: [{ name: "Current project" }] });
    await vi.waitFor(() => expect(currentList?.querySelectorAll("option")).toHaveLength(1));

    expect(firstList?.querySelectorAll("option")).toHaveLength(0);
    expect(currentList?.querySelector("option")?.getAttribute("value")).toBe("Current project");
  });
});
