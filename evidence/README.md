# Evidence

This directory records the evidence the `restoretime` blueprint stands on. It does not replace the
source evidence packages; it indexes them and fixes the conclusions the implementation must trust.

## Sources

| Source | Location | Content |
|---|---|---|
| Webhook campaign (2026-08-08) | `~/Downloads/api-testing-restoration/time-entry-deleted-webhook/` | Three independent live agents (DSWH1/2/3). Verdict: `WEBHOOK_ONLY_SUFFICIENT`. Consensus, payload contract, field coverage, scenarios, disagreements, sanitized payloads. |
| Recreation campaign (2026-08-07) | `~/Downloads/api-testing-restoration/` | Live probes of `/entities/*` feeds, create/delete/update, auth schemes, edge cases. Consensus: recreation `YES_WITH_LIMITATIONS`. |
| Live addendum (2026-08-08, this planning pass) | `webhook-validation.md` §3 | Targeted probes by the architect with the operator API key on the same sacrificial workspace. |
| SDK source | `~/Downloads/working/addons-me/addon-ts-sdk`, `~/Downloads/working/addons-me/clockify-ts-sdk` | Read-only. Integration map: `docs/04-sdk-integration-map.md`. |

## Rules for implementation agents

1. Treat `docs/01-evidence-baseline.md` as the fact inventory. Do not re-litigate facts marked
   `PROVED_3X` without new live evidence.
2. Facts marked `NOT_TESTABLE` or `UNKNOWN` are design constraints, not gaps to close by guessing.
   The release live suite (`docs/13-testing.md`) verifies them on a sacrificial workspace.
3. Never use `/entities/deleted`, `/entities/created`, or `/entities/updated`. Evidence:
   `recreation campaign consensus-report.md`, ADR-002.
4. The webhook payload contract is pinned by sanitized fixtures. `PASS-02` copies fixtures from the
   webhook campaign `sanitized-payloads/` directory into `tests/fixtures/` and tests normalization
   against them.
