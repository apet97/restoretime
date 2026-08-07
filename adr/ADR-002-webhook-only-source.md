# ADR-002 — Webhook-only source; no entity feeds, no snapshots

- Status: accepted 2026-08-08
- Context: The recreation campaign (2026-08-07) designed around `/entities/deleted` + pre-delete
  snapshots because it lacked webhook evidence. It also proved the deleted feed is truncated (no
  interval/project/task/tags/user/CFs), window-exclusionary, and lossy (silent drops). The webhook
  campaign (2026-08-08, 3 agents, tie-broken) then proved `TIME_ENTRY_DELETED` carries the full
  final entry state — a superset of GET (`WEBHOOK_ONLY_SUFFICIENT`).
- Decision: Subscribe to `TIME_ENTRY_DELETED` only. Do not call `/entities/deleted`,
  `/entities/created`, or `/entities/updated`. Do not snapshot entries before deletion.
- Consequences: No polling jobs, no window logic, no experimental-endpoint adapter, no snapshot
  store. The known SDK mistyping of `listDeleted` (docs/04) is irrelevant. If Clockify ever drops a
  needed field from the webhook, reopening this ADR requires new live evidence.
- Evidence: docs/01 W1–W16, R13; `evidence/webhook-validation.md`.
