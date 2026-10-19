# Development

## Requirements

- Python 3.12
- Node.js 22. Newer versions can make some frontend tests fail.
- Optional: Docker, for PostgreSQL and Redis (`docker-compose.dev.yml`)
- Optional: Playwright's Chromium, for server-side export and the end-to-end tests

## Set up and run

```bash
make setup     # virtualenv in backend/.venv, dependencies, backend/.env, local SQLite database
make dev-api   # API on http://localhost:8000 (also serves WebSockets)
make dev-web   # app on http://localhost:5173, in a second terminal; proxies /api and /ws to the API
```

To reuse an existing virtualenv: `make <target> PY=/path/to/venv/bin/python`.

The local settings are in `backend/.env`, created from [`backend/.env.example`](../../backend/.env.example).
Every setting is described in [configuration.md](../self-hosting/configuration.md).

## Make targets

| Target | What it does |
|--------|--------------|
| `make help` | List the targets |
| `make setup` | Install dependencies and prepare the local database |
| `make dev-api`, `make dev-web` | Run the API and the frontend |
| `make migrate` | Apply migrations |
| `make content` | Install the first-run content (templates, elements, fonts, model, audio); downloads, takes minutes |
| `make seed ADMIN_PASSWORD=…` | `content`, plus an admin account (`ADMIN_EMAIL`, default `admin@doory.local`) |
| `make test` | Backend and frontend unit tests ([testing.md](testing.md)) |
| `make lint` | Ruff, TypeScript, ESLint and `docs-check` |
| `make fmt` | Format the backend code |
| `make docs-check` | Check that every setting is documented in configuration.md |
| `make docker-up`, `make docker-down` | Start and stop the full Docker stack |

## Optional local services

```bash
docker compose -f docker-compose.dev.yml up -d                    # PostgreSQL
docker compose -f docker-compose.dev.yml --profile redis up -d    # and Redis
```

Then set `DATABASE_URL` (and `REDIS_URL`) in `backend/.env`.

## Next

- [architecture.md](architecture.md): how the code is organised
- [testing.md](testing.md): unit and end-to-end tests
- [CONTRIBUTING.md](../../CONTRIBUTING.md): pull requests and documentation rules
- [AGENTS.md](../../AGENTS.md): instructions for AI coding agents (`CLAUDE.md` loads the same file)
