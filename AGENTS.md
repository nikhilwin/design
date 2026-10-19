# Instructions for AI coding agents

Doory is a browser-based design editor: a React frontend (`frontend/`) and a Django backend (`backend/`) that
runs as three services (API, realtime WebSockets, MCP). Read [docs/development/architecture.md](docs/development/architecture.md)
before you change code in an area you don't know.

## Commands

```bash
make setup      # backend/.venv, dependencies, backend/.env, local database
make test       # pytest (backend) + vitest (frontend)
make lint       # ruff, ESLint, TypeScript and docs-check: run before you finish
make fmt        # format the backend code
```

- Use Node.js 22. Newer versions make some frontend tests fail.
- Migrations must match the models: `cd backend && python manage.py makemigrations --check --dry-run`.
- On macOS, the export tests need short temp paths: `EXPORT_WORK_DIR=/tmp/dxw TMPDIR=/tmp/dxt`. Image export
  tests also need the built frontend (`cd frontend && npm run build`).
- CI only runs when started by hand, so local `make test` and `make lint` are the real check.

More detail: [docs/development/README.md](docs/development/README.md) and [docs/development/testing.md](docs/development/testing.md).

## Code

- Match the surrounding code: its naming, comment density and style. Python lines are at most 110 characters (ruff).
- Tests go next to the code: `backend/apps/<app>/tests/` and `*.test.ts(x)` beside frontend files.
- New settings are read in `backend/doory/settings/base.py` with `env(...)` and get a safe default. Features
  that call an outside service or add risk (for example MCP or server-side image export) stay off until an
  admin turns them on.

## Documentation is part of the change

If your change adds or renames a setting, adds a service or an outside integration, changes
`docker-compose.yml`, `deploy/` or the steps for upgrading, or adds a command that admins run, update `docs/` in the
same change. [CONTRIBUTING.md](CONTRIBUTING.md#documentation) has the table of which page to update, and the rules.
In short:

- Every setting needs a row in `docs/self-hosting/configuration.md`. `make docs-check` fails otherwise.
- Add pages to the existing folders (`self-hosting/`, `integrations/`, `development/`). Don't add folders, and
  don't rename or move existing pages.
- Name pages after what they do, never after a provider or an issue number.

Changes that only affect the editor, with nothing for admins to do, don't need docs.
