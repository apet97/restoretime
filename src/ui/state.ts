// The one navigation primitive (docs/10). Every view transition is a `Ctx.navigate(state)` call;
// there is no URL routing (the component is a Clockify sidebar iframe, not a standalone page) and
// no browser history — "back" is always an explicit target state a view already knows (docs/10 §6
// "[Back to deleted entries]"), never `history.back()`.

import type { ClockifyBridge } from "@apet97/clockify-addon-sdk/ui";
import type { ApiClient } from "./api.js";
import type { AttemptRecreationResult, BulkPreflightRow, BulkRecreateRow, DeletedTimeEntry, RecreationPlan } from "./types.js";

export type ViewState =
  | { readonly kind: "list" }
  | {
      readonly kind: "detail";
      readonly entryId: string;
      /** Skips the FAILED-state result summary and goes straight to the resolution/preflight
       * form (docs/06 lifecycle table: FAILED's only forward exit is "new plan + claim"). Without
       * this, the result view's own "Try again" button would just redisplay the same failure. */
      readonly forceResolve?: boolean;
    }
  | { readonly kind: "confirm"; readonly entryId: string; readonly plan: RecreationPlan; readonly source: DeletedTimeEntry; readonly disabled?: boolean }
  | {
      readonly kind: "result";
      readonly entryId: string;
      readonly plan: RecreationPlan;
      readonly result: AttemptRecreationResult;
    }
  | { readonly kind: "bulk-review"; readonly rows: readonly BulkPreflightRow[] }
  | { readonly kind: "bulk-results"; readonly rows: readonly BulkRecreateRow[] }
  | { readonly kind: "session-expired" };

export interface Ctx {
  readonly root: HTMLElement;
  readonly api: ApiClient;
  readonly bridge: ClockifyBridge;
  /** Verified-claim display fields (docs/04 §Component verification) — never the token. */
  readonly locale: string;
  readonly isAdminRole: boolean;
  navigate(state: ViewState): void;
}
