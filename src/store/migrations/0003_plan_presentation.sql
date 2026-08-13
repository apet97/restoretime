-- Presentation values for a recreation plan. This JSON can include current labels and a planned
-- substitute or default value when the preview must show it. It must not duplicate source
-- custom-field values. NULL marks a legacy plan that must go through a fresh preflight before
-- recreation.
ALTER TABLE recreation_plans ADD COLUMN presentation_json TEXT;

-- Version-2 rows can retain ambiguity evidence after the entry or attempt reached a definitive
-- state. Keep it only for an AMBIGUOUS attempt or a RECREATING attempt with no outcome; those
-- states still need the evidence.
UPDATE recreation_attempts
SET baseline_json = NULL,
    reconcile_json = NULL
WHERE recoverable_entry_id IN (
  SELECT id
  FROM recoverable_entries
  WHERE lifecycle_state NOT IN ('AMBIGUOUS', 'RECREATING')
)
OR outcome IN ('SUCCESS', 'FAILED');
