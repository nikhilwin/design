"""The credits a design owes for the sounds it uses (Freesound sounds under CC BY), as data and as text.

A track's credit comes from its asset (written by the server at import) and, for a track whose asset is not
the owner's (a guest's file, a copied design), from the credit stored on the track itself. The text is the
same one the editor copies: one line per sound, ready for a caption or a video description. Keep
`creditLine` in `frontend/src/editor/audio/credits.ts` in step.
"""

from __future__ import annotations

import uuid
from typing import Any

from .models import Asset

MAX_FIELD = 200
_FIELDS = ("source", "id", "title", "author", "url", "license", "license_url")


def _clean(credit: object) -> dict[str, Any] | None:
    if not isinstance(credit, dict):
        return None
    out: dict[str, Any] = {
        key: credit[key][:MAX_FIELD] for key in _FIELDS if isinstance(credit.get(key), str)
    }
    if not out.get("title") or not out.get("license"):
        return None
    out["required"] = credit.get("required") is not False and out["license"] != "CC0 1.0"
    return out


def _uuid(value: object) -> uuid.UUID | None:
    try:
        return uuid.UUID(value) if isinstance(value, str) else None
    except ValueError:
        return None


def _short_url(url: str) -> str:
    return url.removeprefix("https://").removeprefix("http://").removeprefix("www.").rstrip("/")


def credit_line(credit: dict[str, Any], kind: str = "sfx") -> str:
    """`Music: "Rainy Lo-fi" by jdoe (freesound.org/people/jdoe/sounds/1), CC BY 4.0`"""
    label = "Music" if kind == "music" else "Sound"
    author = f" by {credit['author']}" if credit.get("author") else ""
    link = f" ({_short_url(credit['url'])})" if credit.get("url") else ""
    return f'{label}: "{credit["title"]}"{author}{link}, {credit["license"]}'


def design_credits(document: dict[str, Any], owner) -> dict[str, Any]:
    """`{"credits": [...], "credits_text": "...", "required": bool}` for the design's audio tracks."""
    tracks = document.get("audioTracks") if isinstance(document, dict) else None
    tracks = [t for t in tracks if isinstance(t, dict)] if isinstance(tracks, list) else []
    asset_ids = {_uuid(t.get("assetId")) for t in tracks} - {None}
    stored: dict[str, Any] = {
        str(asset.pk): (asset.meta or {}).get("credit")
        for asset in Asset.objects.filter(owner=owner, pk__in=asset_ids).only("id", "meta")
    }
    credits: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for track in tracks:
        credit = _clean(stored.get(track.get("assetId", "")) or track.get("credit"))
        if credit is None:
            continue
        key = (credit.get("source", ""), credit.get("id") or credit["title"])
        if key in seen:
            continue
        seen.add(key)
        kind = track.get("kind") if track.get("kind") == "music" else "sfx"
        credits.append({**credit, "kind": kind, "line": credit_line(credit, kind)})
    required = [c for c in credits if c["required"]]
    return {
        "credits": credits,
        "required": bool(required),
        "credits_text": "\n".join(c["line"] for c in required),
    }
