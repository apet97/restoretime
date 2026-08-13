# Marketplace text package

This directory contains the reviewable Marketplace text that engineering can prepare from the
product. Text-package completeness is not production release proof and does not mean that the
add-on was submitted.

## Files here

| File | Content |
|---|---|
| `manifest-review.md` | The reviewable manifest: every field `buildManifest()` (`src/manifest.ts`) sets, as the reviewer will see it at `GET /manifest`, with a pointer to source for each |
| `listing-copy.md` | Paste-ready tagline, short and long descriptions, feature list, screenshot caption candidates, category candidates, support copy, field map, and exact character counts |
| `scope-justification.md` | Per-scope justification text (one paragraph per requested OAuth scope) |
| `privacy-policy.md` | What is stored, what is not, retention, and uninstall behavior — derived from docs/08 (data model) and docs/12 (security) |
| `terminology-check.md` | The ASD-STE100 / mandated-terminology audit run against `README.md`, all application source under `src/`, and the paste-ready listing, privacy, and scope text — real grep output, not an assertion |

## Text-package status

The manifest review, listing copy, scope reasons, privacy text, and terminology record are present.
The short description is 119 of 140 characters. The long description is 1,482 of 1,500 characters.
These counts and the paste-ready values are in `listing-copy.md`.

## Inputs still required

1. **Other image assets.** A reviewable 300 × 300 icon is present in `assets/`. No banner,
   screenshot, or video asset is present.
2. **Production and public URLs.** The production `PUBLIC_BASE_URL`, Support URL, Privacy URL,
   Security URL, and Terms URL are not supplied.
3. **Monitored contact.** The final support, privacy, and security contact is not supplied.
4. **Portal and legal decisions.** The exact category taxonomy, terms, legal approval, pricing, and
   submission action remain outside this text package.

## Release-proof boundary

The 1.3.0/5.1.0 pair in `v1.0.0-rc.10` has historical developer-environment proof in
`evidence/live-release-run.md` "Live run 16". Later worktree changes need new strict receipts for
the exact candidate. Production `app.clockify.me` proof is still open. Do not use these Markdown
files, generated assets, or a workflow definition as proof that a candidate was approved or
submitted. Track those gates in `docs/16-definition-of-done.md`.
