# Server-side export

Most downloads (PNG, JPG, SVG, PDF, MP4, WebM, GIF) are made in the user's browser and don't need the server.
Two exports run on the server, in a headless Chromium:

| Export | Used for | Setting | Default |
|--------|----------|---------|---------|
| Print PDF | Print-quality PDFs | `SERVER_PDF_ENABLED` | on |
| Image of a page (PNG, JPG, WebP) | `POST /api/v1/designs/{id}/export/image/` and the MCP tool `export_design` | `SERVER_IMAGE_EXPORT_ENABLED` | off |

## Requirements

- **Docker:** `INSTALL_CHROMIUM=true` (the default) builds Chromium into the `api` and `mcp` images, which adds
  about 400 MB.
- **Without Docker:** install Playwright's Chromium (see [manual.md](manual.md#optional-server-side-export)), or
  point `EXPORT_CHROMIUM_PATH` at another Chromium.
- **Image export also needs the built frontend's `render.html`** at an address the API (and MCP) service can
  reach. In Docker the default `EXPORT_RENDER_PAGE_URL=http://doory-web:8080/render.html` already works. Without
  Docker the default is `SITE_URL/render.html`, served by nginx from `frontend/dist`. The Vite dev server won't
  work for this.

## Turn it on

```ini
SERVER_IMAGE_EXPORT_ENABLED=true
```

Turning it on runs the editor's drawing code (JavaScript) inside the export browser. The browser can only load
the render page, `/assets/`, and `/media/` and `/static/` from `EXPORT_ALLOWED_ORIGINS`; every other request is
blocked.

To use Docker without Chromium, set `INSTALL_CHROMIUM=false` and `SERVER_PDF_ENABLED=false`, and leave image
export off.

## Settings

See [Server-side export in configuration.md](configuration.md#server-side-export): size limits, concurrency,
timeouts, work folders and file names.

## Housekeeping

Exported images waiting to be downloaded are kept in `EXPORT_STORAGE_ROOT` until their link expires. Expired
images are deleted each time a new one is stored. On a quiet site, `manage.py purge_exports` deletes them too
(see [Scheduled tasks](README.md#scheduled-tasks)).

## Check it works

- Export a design as a print PDF from the editor's Share menu.
- With image export on, sign in and call `POST /api/v1/designs/{id}/export/image/` for one of your designs.

## Troubleshooting

- **Chromium crashes in Docker:** the services set `shm_size: 512m`; keep it. For the `mcp` service, raise
  `MCP_MEM_LIMIT` if it runs out of memory.
- **Exports time out:** raise `EXPORT_TIMEOUT_SECONDS`, or lower `EXPORT_MAX_CONCURRENCY` on small servers.
- **Image export returns blank pages or 404s:** `EXPORT_RENDER_PAGE_URL` must point to the *built* frontend, at an
  address the API container can reach.
- **macOS development, "socket path too long":** set `EXPORT_WORK_DIR` to a short path such as `/tmp/dxw`.
