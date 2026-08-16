# RestoreTime — Time Entry Recovery for Clockify

RestoreTime is a Clockify Marketplace add-on. It helps users recreate deleted time entries.

Use Node 22.13 or later within major version 22.

When a user deletes a time entry in Clockify, RestoreTime keeps the entry's data. The user can then
**recreate** the entry: RestoreTime creates a **new** time entry with the same description, time,
project, task, tags, billable flag, and custom-field values.

The new entry is a separate entity. It has a new ID and a new creation time. It is not part of an
approval request and is not linked to an invoice. Clockify applies the rates that are current at
recreation time. Only regular time entries are recreated — never breaks, time off, or holidays.

## How it works

1. Clockify sends a `TIME_ENTRY_DELETED` webhook to RestoreTime.
2. RestoreTime verifies the webhook and stores the deleted entry's data.
3. The user opens **Time Entry Recovery** in the Clockify sidebar.
4. RestoreTime checks the current workspace: does the project still exist? The task? The tags? Is
   the period locked?
5. The user sees exactly what the new entry will contain, and what must change. The user confirms.
6. RestoreTime creates the new entry and shows the result.

Regular users see their own deleted entries. Workspace admins see all entries in the workspace and
can recreate entries for other users.

## Safety rules

- RestoreTime never changes a value silently. It preserves, asks, warns, or blocks.
- RestoreTime never retries a create request whose result is unknown. If the result is unknown, the
  product says so and helps the user check.
- One deleted entry produces at most one recreated entry. This is enforced by the database, not by
  the UI.
- All permission checks run on the server.
- When Clockify delivers the uninstall lifecycle call, RestoreTime hard-deletes the workspace data
  it holds.

## Local quickstart

### Offline first success

This path needs no Clockify credentials.

```bash
nvm use
npm ci
npm run typecheck
npm run lint
npm run test
npm run test:e2e
```

Success means all tests pass with zero skips. It proves the local source, database contracts, API
behavior with signed test fixtures, and bundled UI journeys. It does not prove a developer
installation, live Clockify, production, Marketplace, Railway, backup, or database recovery.

### Local server preparation

The canonical runtime-variable table is in [docs/05-architecture.md](docs/05-architecture.md).

1. Create `.env` only if it does not exist. This command keeps an existing file or symlink.

```bash
if [ ! -e .env ] && [ ! -L .env ]; then
  cp .env.example .env
fi
```

2. Create the local database directory.

```bash
mkdir -p var
```

3. Generate a 64-character hexadecimal encryption key.

```bash
openssl rand -hex 32
```

4. Paste the generated key into `TOKEN_ENCRYPTION_KEY` in `.env`. Do this before you start the
   server. Do not commit `.env`.

5. Build the app.

```bash
npm run build
```

6. In terminal 1, start the server.

```bash
node --env-file=.env dist/server.js
```

7. In terminal 2, check the server health.

```bash
curl http://127.0.0.1:8080/healthz
```

`/healthz` proves HTTP and SQLite only. It does not prove live Clockify, a developer installation,
Railway, production, Marketplace, backup, or database recovery. The component and `/api/*` need a
verified Clockify component token and a developer add-on installation at a public HTTPS origin.

Do not send an unsigned webhook request. Use the SDK-signed fixtures in
`tests/integration/webhook-ingestion.test.ts`. For the live process, see `docs/13-testing.md`.

### Troubleshooting

| Problem | Next action |
|---|---|
| Wrong Node major or native binding ABI mismatch | Run `nvm use`, then run `npm ci` again. |
| Missing environment variable | Add the required value to `.env`. See the docs/05 configuration table. |
| Invalid 64-hex encryption key | Generate a replacement with `openssl rand -hex 32` and paste the full value into `.env`. |
| Database directory is missing or not writable | Create `var` or set `DATABASE_PATH` to a writable directory. |
| Static bundle is missing | Run `npm run build` before starting the server. |
| Component token is expired or absent | Reload the installed Clockify component. Do not invent a token. |
| Wrong Clockify parent origin | Use `https://developer.clockify.me` for developer or `https://app.clockify.me` for production. |
| Live or developer smoke checks are blocked | Verify the installed developer add-on and its authorized prerequisites. Do not treat a blocked check as live proof. |

## Status

The `v1.0.0-rc.14` developer prerelease points to
`2d5e7fbf3507d520456d60f69f70e29e78d9edb9`. Its local, strict-live, deployment, and cleanup
receipts apply only to that commit. Railway backup creation, backup locking, and isolated database
recovery are **NOT PROVEN — explicitly waived for RC.14**. Production, Marketplace, stable-release,
and disaster-recovery readiness remain unproven. The later documentation receipt commit is not the
RC.14 application candidate. Any later application commit needs new candidate-bound proof.

## Documentation map

| Path | Content |
|---|---|
| `IMPLEMENTER.md` | Developer and maintenance guide |
| `docs/00-product.md` | Product definition and terminology |
| `docs/01-evidence-baseline.md` | Proven API/webhook facts |
| `docs/05-architecture.md` | System design |
| `docs/13-testing.md` | Local, developer, and release evidence boundaries |
| `docs/07-recreation-preflight.md` | The core algorithm |
| `implementation/ROADMAP.md` | Historical implementation pass sequence |
| `evidence/` | Evidence index and validation |
| `adr/` | Architecture decisions |

## License

MIT. See `LICENSE`.
