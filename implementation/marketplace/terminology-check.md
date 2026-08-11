# Terminology check (docs/15 "terminology check"; docs/00, docs/10 §"Terms used in the UI")

Mandated terms: **recreate / recreation / recreated, deleted entry, new entry**. Forbidden, except
when quoting Clockify documentation about unrelated behavior: **restore, restored, undelete, native
restore, same entry, original entry**.

## Scope

Scanned the top-level `README.md`, all application source under `src/`, and the paste-ready listing,
privacy, and scope text in this directory. Scanning all source is deliberately broader than the
user-facing string locations, so a moved plan or error message cannot fall outside the check.

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
    README.md src \
    implementation/marketplace/listing-copy.md implementation/marketplace/privacy-policy.md \
    implementation/marketplace/scope-justification.md
(no matches)
```

Mandated-terms presence (confirms the check is real — it also verifies the correct words ARE used,
not only that the wrong ones are absent):

```text
$ grep -rniE "\brecreat(e|ed|ion|ing)\b" \
    README.md src \
    implementation/marketplace/listing-copy.md implementation/marketplace/privacy-policy.md \
    implementation/marketplace/scope-justification.md | wc -l
150
$ grep -rniE "\bdeleted entry\b|\bnew entry\b" \
    README.md src \
    implementation/marketplace/listing-copy.md implementation/marketplace/privacy-policy.md \
    implementation/marketplace/scope-justification.md | wc -l
34
```

## Result

Zero forbidden-term matches across the scanned user-facing surfaces. The mandated terms are in
active use: 150 matching lines for recreate/recreation/recreated and 34 matching lines for deleted
entry/new entry. These counts were recorded on 2026-08-10 after the Marketplace text update. Rerun
the commands after a later user-facing text change.

## Whole-source check (informational)

The broader source check includes code comments and internal errors, not only rendered text:

```text
$ grep -rniE "\brestor(e|ed|ation|ing)?\b" src/ | grep -viE "restoretime"
(no matches)
```

No application source uses a forbidden product term.
