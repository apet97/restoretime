# Terminology check (docs/15 "terminology check"; docs/00, docs/10 §"Terms used in the UI")

Mandated terms: **recreate / recreation / recreated, deleted entry, new entry**. Forbidden, except
when quoting Clockify documentation about unrelated behavior: **restore, restored, undelete, native
restore, same entry, original entry**.

## Scope

Scanned every user-facing surface: the iframe UI (`src/ui/`), the app-API error/status strings a
user can see (`src/api/routes.ts`), the component HTML shell (`src/api/views.ts`), and the manifest
`name`/`description` fields users see in Clockify's addon listing and install prompt
(`src/manifest.ts`).

**Deliberately out of scope**, and why:

- The product's own name, **RestoreTime**, contains the string "restor" but is a proper noun, not a
  claim about what the product does to a deleted entry — the mandated-terminology rule (AGENTS.md
  rule 20, docs/00) governs the verbs and nouns describing the *action* ("recreate", "recreated
  entry"), not the brand name.
- Internal engineering documentation (docs/14 "Rollback", docs/15 "Rollback") uses "restore" in its
  ordinary infrastructure sense — "restore the database file from backup" — which is standard
  operations vocabulary for a file-system operation, not a claim about what happens to a Clockify
  time entry. No workspace admin installing the addon ever reads docs/14 or docs/15; they are
  engineering-facing.

## Commands run and real output

Forbidden-terms sweep (user-facing surfaces only):

```text
$ grep -rniE "\brestor(e|ed|ation|ing)?\b|\bundelete[d]?\b|\boriginal entry\b|\bsame entry\b" \
    src/ui src/api/routes.ts src/api/views.ts src/manifest.ts
(no matches)
```

Mandated-terms presence (confirms the check is real — it also verifies the correct words ARE used,
not only that the wrong ones are absent):

```text
$ grep -rniE "\brecreat(e|ed|ion|ing)\b" src/ui src/api/routes.ts src/api/views.ts src/manifest.ts | wc -l
54
$ grep -rniE "\bdeleted entry\b|\bnew entry\b" src/ui src/api/routes.ts src/api/views.ts src/manifest.ts | wc -l
11
```

## Result

Zero forbidden-term matches across every user-facing surface; the mandated terms are in active use
(54 recreate/recreation/recreated occurrences, 11 deleted-entry/new-entry occurrences). This
matches docs/16's quality bar ("Every user-facing string follows docs/10 terminology") and the same
sweep run for this PASS-05 report — see the box-by-box state in `implementation/reports/PASS-05.md`.

## Whole-repository check (informational, not a gate)

Repository-wide (including code comments, ADRs, and docs — where "restore"/"undelete" legitimately
appear as engineering vocabulary, e.g. AGENTS.md's own statement of the rule, and docs/14/15's
"restore the database file"):

```text
$ grep -rniE "\brestor(e|ed|ation|ing)?\b" src/ | grep -viE "restoretime"
src/domain/entry.ts:3:// restore/undelete/original entry (AGENTS.md rule 20).
```

The one hit is the code comment stating the rule itself — not a user-facing string.
