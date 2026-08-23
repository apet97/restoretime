# RestoreTime — Time Entry Recovery for Clockify

[![CI](https://github.com/apet97/restoretime/actions/workflows/ci.yml/badge.svg)](https://github.com/apet97/restoretime/actions/workflows/ci.yml)
[![Node 22](https://img.shields.io/badge/node-%E2%89%A522.13%20%3C23-339933?logo=node.js&logoColor=white)](.nvmrc)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

RestoreTime is a Clockify Marketplace add-on. It helps users recreate deleted time entries.

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
- When Clockify delivers the uninstall lifecycle call, RestoreTime hard-deletes the data that
  installation holds. Clockify issues a fresh add-on id per install, so a reinstall starts empty
  and a delayed uninstall for an older installation cannot touch the current one's data.
- A webhook still being verified when an uninstall lands writes nothing: the database, not an
  in-memory check, enforces it.

## The component

RestoreTime renders one sidebar component inside Clockify. It is plain TypeScript with no UI
framework, bundled once with esbuild.

- **Follows the Clockify theme.** Light and dark palettes come from one token set, and native
  controls follow through `color-scheme`.
- **Visible progress.** Every busy button, loading placeholder, and inline status shows the same
  CSS-only spinner with a visible label and `aria-busy`. `prefers-reduced-motion` switches the
  spinner and all transitions off.
- **Keyboard-friendly filters.** Admins filter by user, project, date range, status, and
  description text. Enter in any filter field applies the filters.
- **Every entry is reachable.** The list pages 50 rows at a time with a Load more continuation, so
  a long backlog never hides its tail behind a filter.
- **Accessible by contract.** Screen headings take focus and announce, action errors keep their
  context and always offer one safe next action, and the e2e suite enforces these behaviors.

The full specification is [docs/10-ui-specification.md](docs/10-ui-specification.md).

## Local quickstart

Use Node 22.13 or later within major version 22 (`.nvmrc` selects it).

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

Verified on the sacrificial developer workspace. **Not** production- or Marketplace-ready: Railway
backup, point-in-time recovery, and isolated restore are unproven, `main` and release tags are
unprotected, and the release-candidate gates beyond ordinary CI are not enforced by the merge path.
Those three are what a production claim would rest on, so this repository does not make one.

The `v1.0.0-rc.14` developer prerelease points to
`2d5e7fbf3507d520456d60f69f70e29e78d9edb9`. Its local, strict-live, deployment, and cleanup
receipts apply only to that commit; later application commits need their own candidate-bound
proof.

`main` has moved past that tag and is **not** a release candidate. The current developer
deployment runs `17438570dfb97f0982e0617648bf7b914a1611e3`, on which the strict live gate passed
three times with zero skips and fresh LV-01B and LV-02B receipts, and the workspace was left clean
(docs/15). That is evaluation evidence on the developer environment; it does not make the commit a
candidate or change anything in the paragraph above.

## Documentation map

| Path | Content |
|---|---|
| `IMPLEMENTER.md` | Developer and maintenance guide |
| `docs/00-product.md` | Product definition and terminology |
| `docs/01-evidence-baseline.md` | Proven API/webhook facts |
| `docs/05-architecture.md` | System design |
| `docs/13-testing.md` | Local, developer, and release evidence boundaries |
| `docs/07-recreation-preflight.md` | The core algorithm |
| `evidence/` | Evidence index and validation |
| `adr/` | Architecture decisions |

## License

MIT. See `LICENSE`.
