# TASK-05 — Product UI

- Pass: PASS-03
- Goal: every view and state in docs/10, against the live engine.
- Why: the UI is where honesty rules (no silent changes, explicit differences) become visible.
- Prerequisites: PASS-02 merged.
- Files/modules: `src/ui/*`, `src/api/views.ts`, bulk endpoints in `src/api/routes.ts`.
- Interfaces: docs/10 views/widgets/strings; SDK `./ui` bridge.
- Behavior: list (user/admin), detail with planned-vs-original columns, resolution widgets,
  confirm, success/failed/unknown-result, bulk review, dismissed toggle, disabled notice. Token
  refresh (fact 13): the refreshed token arrives as a window message
  `{title: "refreshAddonToken", body: <token string>}`; `bridge.subscribe("refreshAddonToken",
  ...)`; proactive refresh every 25 min (tokens live 30 min); on API 401: dispatch refresh, await
  with 5 s timeout, retry once; timeout → session-expired notice.
- Failure behavior: 401 → token refresh + one retry; engine error → the failure views of docs/10
  §6/§8.
- Tests: E2E suite + UT-X01 extension.
- Acceptance: PASS-03 completion criteria incl. the terminology grep.
