# Marketplace submission package (docs/15 "Marketplace submission prerequisites")

Staged for the Clockify Marketplace review. This directory holds everything the operator does not
have to write from scratch; it does **not** hold anything only the operator can supply.

## Files here

| File | Content |
|---|---|
| `manifest-review.md` | The reviewable manifest: every field `buildManifest()` (`src/manifest.ts`) sets, as the reviewer will see it at `GET /manifest`, with a pointer to source for each |
| `scope-justification.md` | Per-scope justification text (one paragraph per requested OAuth scope) |
| `privacy-policy.md` | What is stored, what is not, retention, and uninstall behavior — derived from docs/08 (data model) and docs/12 (security) |
| `terminology-check.md` | The ASD-STE100 / mandated-terminology audit run against every user-facing string in `src/ui/` and `src/api/` (docs/00, docs/10 §"Terms used in the UI") — real grep output, not an assertion |

## What only the operator can supply

These are not filled in here because no one but the operator has them. Each is named explicitly so
the release checklist (docs/16) has one line per gap, not a vague "TBD":

1. **Icon artwork.** The current sidebar icon (`ADDON_ICON_SVG`, `src/server.ts`) is a small
   circular-arrow SVG built for the sidebar tile — functional, not a designed marketplace listing
   icon. If the Marketplace listing requires a separate, larger, brand-reviewed icon asset, the
   operator supplies it.
2. **Screenshots.** None exist. The operator captures these from a real installed instance (they
   necessarily show the running product, which does not exist until step 3 of docs/15's release
   pipeline has happened).
3. **Long-form listing description.** `buildManifest()`'s `.description(...)` call is the short,
   in-manifest description Clockify itself displays close to the install button; a Marketplace
   listing page typically wants a longer write-up (features, screenshots captions, FAQ). Draft
   text for that longer page is the operator's call — it is marketing copy, not manifest content,
   and mixing the two would make this package overreach into decisions this pass was not asked to
   make.
4. **Production host.** `PUBLIC_BASE_URL`, DNS, and TLS termination for the production deployment.
   Every file in this package describes the product as its code defines it; none of them can name
   a host that does not exist yet.

## Everything else here is real content, not a placeholder

The manifest fields, scope list, and privacy text below are read directly from the shipped code
(`src/manifest.ts`, `src/config.ts`, `docs/08-data-model.md`, `docs/12-security.md`) — they are
what the reviewer will actually see, not a draft written ahead of the code.
