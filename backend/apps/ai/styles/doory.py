"""Doory-compatible: Doory's own small open contract (`apps/ai/contract/openapi.yaml`).

* `GET {base}/v1/models` → `{"models": [{"id", "label", "tasks": [...]}]}`
* `POST {base}/v1/{task}`, multipart `image`, optional `model` and `options` (JSON) → a PNG, or JSON
  `{"image_b64": …}`
"""

from __future__ import annotations

from typing import Any

from ..errors import AIProviderError
from .base import ApiStyle, Connection, OutgoingRequest, RemoteModel, Send, expect_ok, load_json

MAX_MODELS = 200
MAX_MODELS_BYTES = 1024 * 1024


class DooryStyle(ApiStyle):
    name = "doory"
    label = "Doory-compatible"
    help = "No settings: the server implements Doory's contract (GET /v1/models, POST /v1/{task})."
    keys = frozenset({"extra_headers"})
    fixed = {
        "path": "/v1/{task}",
        "body": "multipart",
        "send_as": "file",
        "file_field": "image",
        "model_field": "model",
        "options_field": "options",
        "response": "auto",
        "response_path": "image_b64",
    }
    can_list_models = True

    def list_models(self, connection: Connection, send: Send) -> list[RemoteModel]:
        headers = {
            **connection.config.extra_headers,
            **connection.auth_headers(),
            "Accept": "application/json",
        }
        response = send(OutgoingRequest("GET", connection.url("/v1/models"), headers, b""), MAX_MODELS_BYTES)
        expect_ok(response)
        data: Any = load_json(response)
        items = data.get("models") if isinstance(data, dict) else None
        if not isinstance(items, list):
            raise AIProviderError("bad_response", "The server's model list is not in the expected format.")
        models: list[RemoteModel] = []
        for item in items[:MAX_MODELS]:
            if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"].strip():
                continue
            label = item.get("label")
            tasks = item.get("tasks")
            models.append(
                RemoteModel(
                    remote_name=item["id"].strip()[:200],
                    label=(label.strip() if isinstance(label, str) else "")[:80],
                    tasks=tuple(t for t in tasks if isinstance(t, str)) if isinstance(tasks, list) else (),
                )
            )
        return models
