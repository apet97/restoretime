// The one navigation primitive (docs/10). Every view transition is a `Ctx.navigate(state)` call;
// there is no URL routing (the component is a Clockify sidebar iframe, not a standalone page) and
// no browser history — "back" is always an explicit target state a view already knows (docs/10 §6
// "[Back to deleted entries]"), never `history.back()`.

import type { ClockifyBridge } from "@apet97/clockify-addon-sdk/ui";
import type { ApiClient } from "./api.js";
import type {
  ActionRequiredItem,
  AttemptRecreationResult,
  BulkPreflightRow,
  BulkRecreateRow,
  DeletedTimeEntry,
  PreflightChoices,
  RecreationPlan,
} from "./types.js";

export interface UiSessionState {
  readonly list: {
    userName: string;
    projectName: string;
    from: string;
    to: string;
    status: string;
    search: string;
    dismissed: boolean;
    bulkMode: boolean;
  };
  readonly selectedEntryIds: Set<string>;
  bulkReviewRows: readonly BulkPreflightRow[] | null;
}

export function createUiSessionState(): UiSessionState {
  return {
    list: { userName: "", projectName: "", from: "", to: "", status: "", search: "", dismissed: false, bulkMode: false },
    selectedEntryIds: new Set(),
    bulkReviewRows: null,
  };
}

export type ReturnTarget = "list" | "bulk-review";

/** Browser-only labels retained while a user edits a plan. Persisted and reopened plans use the
 * server's `plan.presentation`; these labels only bridge the current selection round-trip. */
export interface ChoiceLabels {
  project?: { readonly id: string; readonly name: string } | null;
  task?: { readonly id: string; readonly name: string } | null;
  tags: Record<string, string>;
  customFields: Record<string, string>;
}

export interface ResolutionDraft {
  readonly choices: PreflightChoices;
  readonly actionRequired: readonly ActionRequiredItem[];
  readonly labels: ChoiceLabels;
}

export type ViewState =
  | { readonly kind: "list" }
  | {
      readonly kind: "detail";
      readonly entryId: string;
      /** Skips the FAILED-state result summary and goes straight to the resolution/preflight
       * form (docs/06 lifecycle table: FAILED's only forward exit is "new plan + claim"). Without
       * this, the result view's own "Try again" button would just redisplay the same failure. */
      readonly forceResolve?: boolean;
      readonly draft?: ResolutionDraft;
      readonly returnTo?: ReturnTarget;
    }
  | {
      readonly kind: "confirm";
      readonly entryId: string;
      readonly plan: RecreationPlan;
      readonly source: DeletedTimeEntry;
      readonly disabled?: boolean;
      readonly draft?: ResolutionDraft;
      readonly returnTo?: ReturnTarget;
    }
  | {
      readonly kind: "result";
      readonly entryId: string;
      readonly plan: RecreationPlan;
      readonly result: AttemptRecreationResult;
      readonly returnTo?: ReturnTarget;
    }
  | { readonly kind: "bulk-review"; readonly rows: readonly BulkPreflightRow[]; readonly refresh?: boolean }
  | { readonly kind: "bulk-results"; readonly rows: readonly BulkRecreateRow[]; readonly reviewRows?: readonly BulkPreflightRow[] }
  | { readonly kind: "session-expired" };

export interface Ctx {
  readonly root: HTMLElement;
  readonly api: ApiClient;
  readonly bridge: ClockifyBridge;
  /** Verified-claim display fields (docs/04 §Component verification) — never the token. */
  readonly locale: string;
  readonly isAdminRole: boolean;
  readonly session: UiSessionState;
  /** Changes before each view transition. Async work uses this value to avoid replacing a newer
   * view after the user navigates away. */
  getNavigationVersion(): number;
  navigate(state: ViewState): void;
  announce(message: string): void;
  reload(): void;
}
