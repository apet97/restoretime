# Implementation roadmap

Historical record: these five passes describe the original implementation sequence. They are not
the RC.11 release procedure. Use `docs/15-release.md` for the current developer-only candidate.

Five passes. Each is a standalone agent prompt in `passes/`. Execute in order; each pass's gates
must be green before the next begins.

```text
PASS-01 Foundation and platform boundaries
   package, toolchain, DB+migrations, manifest, lifecycle, installation store,
   verified component shell, test harness, CI
        ↓
PASS-02 Recovery engine
   webhook ingestion, normalization, persistence, authorization, preflight,
   plans, claim, recreate mutation, verification diff, ambiguity protocol, lineage
        ↓
PASS-03 User product
   iframe UI: lists (user/admin), filters, detail, resolutions, confirm,
   result states, bulk (admin)
        ↓
PASS-04 Hardening
   edge-case completion, concurrency proof, permission negatives, XSS proof,
   privacy audit, performance sanity, ops wiring
        ↓
PASS-05 Release
   live suite on sacrificial workspace, adversarial review, release pipeline,
   Marketplace package, rollback drill, tag
```

Dependency logic:

- The engine (PASS-02) needs the platform boundaries (PASS-01): verified webhooks need the
  installation store (per-installation tokens), and verified API calls need the component JWT
  plumbing.
- The UI (PASS-03) needs real engine behavior to render; building it earlier produces fiction.
- Hardening (PASS-04) needs a complete product to attack.
- Release (PASS-05) needs everything green plus the live suite, which needs a deployable build.

Rules for every pass agent:

1. Read `IMPLEMENTER.md` first; it fixes the reading order.
2. Do not redesign proven contracts. `docs/01-evidence-baseline.md` facts marked PROVED are inputs,
   not hypotheses.
3. Do not add dependencies, abstractions, or files beyond the pass scope.
4. A gate that cannot run (e.g. live suite without credentials) is reported as blocked with the
   exact missing input — never replaced by a weaker local substitute and never silently skipped.
