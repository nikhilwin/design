# Realtime co-editing

Live co-editing runs over WebSockets at `/ws/`, in its own service: `realtime` in Docker, `doory-realtime` without
Docker. It uses the same code as the API, run by uvicorn.

## Requirements

- The proxy forwards WebSockets on `/ws/`. The bundled nginx configs already do this.
- With one worker (the default), you don't need anything else.
- With more than one worker or server, you need Redis so they can share updates.

## Turn it on or off

It's on by default. Set `REALTIME_ENABLED=false` to turn it off; designs then save normally, without live
updates.

## Several workers

Docker:

```ini
COMPOSE_PROFILES=redis
REDIS_URL=redis://redis:6379/0
REALTIME_WORKERS=4
```

Then run `docker compose up -d`. Without Docker, point `REDIS_URL` at your Redis, raise `--workers` in
`doory-realtime.service`, and restart the services.

Redis also makes MCP edits show up immediately in open editors. Without it they appear within a few seconds.

## Settings

The connection and rate limits are listed under
[Realtime co-editing in configuration.md](configuration.md#realtime-co-editing). The defaults suit most sites.

## Maintenance

`manage.py collab_maintenance` does three things:

- saves designs whose live state got ahead of the saved document, e.g. after a crash;
- folds long update logs into a snapshot;
- removes presence entries left by processes that are gone.

It's safe to run at any time. Schedule it as described in [Scheduled tasks](README.md#scheduled-tasks).

## Troubleshooting

- **Editors don't see each other's changes:** check that `/ws/` reaches the realtime service (look for failed
  WebSocket requests in the browser's network tab) and that the proxy passes the `Upgrade` and `Connection`
  headers.
- **Changes only reach some editors:** you're running several workers without Redis. Set `REDIS_URL`.
