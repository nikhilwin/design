"""The audio library: a static catalogue of music loops and sound effects served from `MEDIA_ROOT/audio/`.

`backend/data/audio_library.json` (the manifest) lists every bundled file with its checksum; `manage.py
sync_audio` installs the files under hashed names and writes `MEDIA_ROOT/audio/index.json`, which the
editor fetches once, caches, and searches in the browser.
"""
