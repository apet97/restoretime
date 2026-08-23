-- Installation-generation ownership. Clockify issues a fresh `addonId` for every install of an
-- add-on into a workspace, so `(workspace_id, addon_id)` — already the `installations` primary
-- key — identifies one installation lifetime, while `workspace_id` alone identifies only the
-- tenant. Product rows carried the tenant key only, which let an uninstall of one generation
-- delete a later generation's data, and let a reinstall inherit the previous generation's entries
-- whenever a DELETED event was missed. Add-only (AGENTS.md rule 18): 0001-0003 are never edited.

-- `DEFAULT ''` exists only because SQLite cannot add a NOT NULL column without one; it is not a
-- reachable value. Every application INSERT names `addon_id`, and the statements below attribute
-- or delete every row that still holds the placeholder.
ALTER TABLE recoverable_entries ADD COLUMN addon_id TEXT NOT NULL DEFAULT '';

-- Attribute existing rows to the newest installation of their workspace. Clockify allows one
-- installation of an add-on per workspace at a time, so the newest row is the generation that
-- captured this data or inherited it under the old workspace-only scope.
-- COALESCE, not a bare subquery: a workspace with no installation row yields NULL, which the NOT
-- NULL column rejects outright. Such rows must fall through to the placeholder and be deleted
-- below, not abort the migration for every other workspace in the database.
UPDATE recoverable_entries
SET addon_id = COALESCE((
  SELECT i.addon_id
  FROM installations i
  WHERE i.workspace_id = recoverable_entries.workspace_id
  ORDER BY i.installed_at DESC, i.addon_id DESC
  LIMIT 1
), '')
WHERE addon_id = '';

-- A row whose workspace holds no installation belongs to a generation that is already gone. Every
-- API route scopes by the viewer's own installation, so such a row is unreachable and keeping it
-- would only retain deleted-entry data after an uninstall. Plans and attempts cascade.
DELETE FROM recoverable_entries WHERE addon_id = '';

-- Collapse generations whose DELETED event never arrived, on the same reasoning the
-- supersede-on-INSTALLED path uses: a newer generation for the workspace proves the older one was
-- removed in Clockify. Their entries were just attributed to the surviving generation above.
DELETE FROM installations
WHERE EXISTS (
  SELECT 1
  FROM installations newer
  WHERE newer.workspace_id = installations.workspace_id
    AND (
      newer.installed_at > installations.installed_at
      OR (newer.installed_at = installations.installed_at AND newer.addon_id > installations.addon_id)
    )
);

-- Both replaced indexes led with `workspace_id` alone, which no query uses any more.
DROP INDEX recoverable_entries_owner_idx;
DROP INDEX recoverable_entries_detected_idx;
CREATE INDEX recoverable_entries_owner_idx
  ON recoverable_entries(workspace_id, addon_id, owner_id);
-- Serves the keyset list order (docs/03 `GET /api/entries`): scope, then detected_at DESC, id DESC.
CREATE INDEX recoverable_entries_page_idx
  ON recoverable_entries(workspace_id, addon_id, detected_at DESC, id DESC);
