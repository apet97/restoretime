-- Retired installation generations.
--
-- Lifecycle tokens do not expire: the SDK's lifecycle verifier defaults `requireExpiration` to
-- false, because Clockify's lifecycle authToken carries no `exp`. A delayed or replayed INSTALLED
-- for a generation that is already gone is therefore possible at any later time, and it carries
-- nothing this app can order against a current installation — the payload has no timestamp, and
-- `installed_at` is stamped at processing time, so a replay always looks newest.
--
-- Without a record of what has already been retired, such an event would drive
-- `supersedeOtherInstallations` and destroy the *current* generation's data: the same defect as a
-- stale DELETED, arriving through the other lifecycle event. This table is that record. Once a
-- generation is retired it never again becomes a reason to purge another one.
--
-- One row per generation ever retired, so growth is bounded by installs, not by usage.
CREATE TABLE retired_installations (
  workspace_id TEXT NOT NULL,
  addon_id     TEXT NOT NULL,
  retired_at   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, addon_id)
);

-- Collapse generations whose DELETED event never arrived, on the same reasoning the
-- supersede-on-INSTALLED path uses: a newer generation for the workspace proves the older one was
-- removed in Clockify. 0004 already attributed their entries to the surviving generation. Recording
-- them first is what stops a replayed INSTALLED for one of them from purging that survivor.
INSERT OR IGNORE INTO retired_installations (workspace_id, addon_id, retired_at)
SELECT workspace_id, addon_id, datetime('now')
FROM installations AS older
WHERE EXISTS (
  SELECT 1
  FROM installations newer
  WHERE newer.workspace_id = older.workspace_id
    AND (
      newer.installed_at > older.installed_at
      OR (newer.installed_at = older.installed_at AND newer.addon_id > older.addon_id)
    )
);

DELETE FROM installations
WHERE (workspace_id, addon_id) IN (SELECT workspace_id, addon_id FROM retired_installations);
