-- docs/08 "installations" table. Implements the addon SDK ClockifyInstallationStore contract.
-- auth_token and the tokens inside webhooks_json are encrypted by the SDK codec before this
-- table ever sees them (wrapClockifyInstallationStoreWithEncryption) — this migration only
-- shapes storage, it never decrypts.
CREATE TABLE installations (
  workspace_id  TEXT NOT NULL,
  addon_id      TEXT NOT NULL,
  addon_user_id TEXT NOT NULL,
  as_user       TEXT NOT NULL,
  api_url       TEXT NOT NULL,
  auth_token    TEXT NOT NULL,
  webhooks_json TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  installed_at  INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, addon_id)
);
