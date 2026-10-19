#!/bin/sh
# Prepares the database and static files, then hands over to the server command. Anything other than
# the server (for example `manage.py createsuperuser`) skips the preparation and runs as given.
set -eu

wait_for_database() {
    python - <<'PY'
import sys
import time

import django

django.setup()
from django.db import connections
from django.db.utils import OperationalError

for attempt in range(1, 31):
    try:
        connections["default"].ensure_connection()
        break
    except OperationalError as exc:
        print(f"Waiting for the database ({attempt}/30): {exc}".strip(), flush=True)
        time.sleep(2)
else:
    sys.exit("The database did not become available in time.")
PY
}

sync_fonts_once() {
    marker="${MEDIA_ROOT:-/app/media}/fonts/.synced"
    if [ -f "$marker" ] || ! python manage.py help sync_fonts >/dev/null 2>&1; then
        return 0
    fi
    echo "Downloading the font catalog (first start)..."
    # shellcheck disable=SC2086  # DOORY_SYNC_FONTS_ARGS is a space-separated list of options
    # sync_fonts refuses to run without a selection, so an empty value means the 100 most popular families.
    if python manage.py sync_fonts ${DOORY_SYNC_FONTS_ARGS:---popular 100}; then
        mkdir -p "$(dirname "$marker")" && touch "$marker"
    else
        echo "Font sync failed; the server starts anyway. Run 'manage.py sync_fonts' again later." >&2
    fi
}

sync_elements() {
    if ! python manage.py help sync_element_packs >/dev/null 2>&1; then
        return 0
    fi
    echo "Installing the element catalog (shapes, graphics, icon, emoji and illustration packs)..."
    python manage.py seed_elements || echo "seed_elements failed; the server starts anyway." >&2
    # shellcheck disable=SC2086  # DOORY_SYNC_ELEMENTS_ARGS is a space-separated list of options
    if ! python manage.py sync_element_packs ${DOORY_SYNC_ELEMENTS_ARGS:-}; then
        echo "Element sync failed; the server starts anyway. Run 'manage.py sync_element_packs' again later." >&2
    fi
}

sync_models() {
    if ! python manage.py help sync_models >/dev/null 2>&1; then
        return 0
    fi
    echo "Installing the background-removal model..."
    # shellcheck disable=SC2086  # DOORY_SYNC_MODELS_ARGS is a space-separated list of options
    if ! python manage.py sync_models ${DOORY_SYNC_MODELS_ARGS:-}; then
        echo "Model sync failed; the server starts anyway. Run 'manage.py sync_models' again later." >&2
    fi
}

sync_audio() {
    if ! python manage.py help sync_audio >/dev/null 2>&1; then
        return 0
    fi
    echo "Installing the audio library (music loops and sound effects)..."
    # shellcheck disable=SC2086  # DOORY_SYNC_AUDIO_ARGS is a space-separated list of options
    if ! python manage.py sync_audio ${DOORY_SYNC_AUDIO_ARGS:-}; then
        echo "Audio sync failed; the server starts anyway. Run 'manage.py sync_audio' again later." >&2
    fi
}

seed_templates() {
    if ! python manage.py help seed_templates >/dev/null 2>&1; then
        return 0
    fi
    echo "Adding the starter templates (existing ones are left alone)..."
    python manage.py seed_templates || echo "Template seeding failed; the server starts anyway. Run 'manage.py seed_templates' again later." >&2
}

import_size_presets() {
    if ! python manage.py help import_size_presets >/dev/null 2>&1; then
        return 0
    fi
    mode="${DOORY_SIZE_PRESETS_MODE:-extend}"
    echo "Importing size presets from ${DOORY_SIZE_PRESETS_FILE} (${mode})..."
    if ! python manage.py import_size_presets "$DOORY_SIZE_PRESETS_FILE" --mode "$mode"; then
        echo "Size preset import failed; the server starts anyway with the presets it had. Fix the file and restart." >&2
    fi
}

if [ "${1:-}" = "gunicorn" ]; then
    wait_for_database
    python manage.py migrate --noinput
    python manage.py createcachetable
    python manage.py collectstatic --noinput
    if [ "${DOORY_SYNC_FONTS:-false}" = "true" ]; then
        sync_fonts_once
    fi
    if [ "${DOORY_SYNC_ELEMENTS:-false}" = "true" ]; then
        sync_elements
    fi
    if [ "${DOORY_SYNC_MODELS:-false}" = "true" ]; then
        sync_models
    fi
    if [ "${DOORY_SYNC_AUDIO:-false}" = "true" ]; then
        sync_audio
    fi
    if [ "${DOORY_SEED_TEMPLATES:-false}" = "true" ]; then
        seed_templates
    fi
    if [ -n "${DOORY_SIZE_PRESETS_FILE:-}" ]; then
        import_size_presets
    fi
fi

if [ "${1:-}" = "uvicorn" ]; then
    # The real-time server shares the database with the API, which owns the migrations.
    wait_for_database
    if [ "${REALTIME_WORKERS:-1}" -gt 1 ] && [ -z "${REDIS_URL:-}" ]; then
        echo "REALTIME_WORKERS=${REALTIME_WORKERS} needs REDIS_URL: workers share live rooms through Redis." >&2
        echo "Set REDIS_URL (docker compose --profile redis) or run a single worker." >&2
        exit 1
    fi
fi

exec "$@"
