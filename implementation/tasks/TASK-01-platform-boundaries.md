# TASK-01 — Platform boundaries

- Pass: PASS-01
- Goal: manifest, lifecycle, encrypted installation store, verified component shell, app-API guard.
- Why: every later boundary (webhook tokens, viewer identity) depends on these.
- Prerequisites: none.
- Files/modules: `src/manifest.ts`, `src/server.ts`, `src/platform/*`, `src/store/*` (installations
  only), `src/api/routes.ts` (guard + ping), `.github/workflows/ci.yml`.
- Interfaces: docs/04 addon-SDK rows only.
- Behavior: INSTALLED persists encrypted context incl. webhook tokens; STATUS_CHANGED flips status;
  DELETED removes the installation; `/component` and `/api/*` reject bad signatures with 401.
- Failure behavior: unknown lifecycle payload → 401; DB failure on install → 500 (Clockify retries
  the lifecycle event).
- Tests: PASS-01 test list (signed/unsigned/expired matrix, generation guard, migrations).
- Acceptance: PASS-01 completion criteria.
