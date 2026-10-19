"""Machine-learning model files the browser downloads from Doory itself.

`manifest` is the reviewed list (exact file, SHA-256, licence), `sources` fetches a file, `install` puts a
verified copy under `MEDIA_ROOT/models/` and `availability` tells `GET /api/v1/config/` what is installed.
"""
