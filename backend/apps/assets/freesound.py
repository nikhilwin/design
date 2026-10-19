"""Freesound (freesound.org): search sounds and copy one into the user's uploads.

The licence is decided here, never by the client: every search carries a licence filter built from
`FREESOUND_LICENSES` (CC0 only by default; `by` adds Creative Commons Attribution), and an import re-reads the
sound's own licence before anything is downloaded. NC, Sampling+ and the rest are never allowed.
The key goes in a header, so it is never part of a URL. Previews and imports are fetched by the server from
Freesound's CDN only (https, allow-listed host on every redirect hop), like stock photos.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from django.conf import settings
from django.core.cache import cache

from . import providers, stocklimits
from .providers import ProviderError, _as_int, _as_str, _dict, _https_link, _next_page

NAME = "freesound"
LABEL = "Freesound"
HOME_URL = "https://freesound.org/"
API = "https://freesound.org/apiv2"
CDN_HOSTS = frozenset({"cdn.freesound.org"})
FIELDS = "id,name,username,license,duration,previews,category,subcategory,url,tags"
MAX_PER_PAGE = 30
MAX_SECONDS = 15 * 60  # the editor's longest source
SOUND_CACHE_SECONDS = 24 * 60 * 60
_ID = re.compile(r"[0-9]{1,12}")
_USER = re.compile(r"[\w.@+-]{1,100}")

# Freesound's Broad Sound Taxonomy, as the filters of the tab: type -> its category and subcategories.
TYPES: dict[str, dict[str, Any]] = {
    "music": {
        "category": "Music",
        "subcategories": ["Solo instrument", "Solo percussion", "Multiple instruments", "Other"],
    },
    "effects": {
        "category": "Sound effects",
        "subcategories": [
            "Objects / House appliances",
            "Human sounds and actions",
            "Natural elements and explosions",
            "Animals",
            "Vehicles",
            "Other mechanisms, engines, machines",
            "Electronic / Design",
            "Experimental",
            "Other",
        ],
    },
    "ambience": {
        "category": "Soundscapes",
        "subcategories": ["Nature", "Urban", "Indoors", "Synthetic / Artificial", "Other"],
    },
}
LENGTHS = {"any": None, "short": (0, 5), "medium": (5, 30), "long": (30, 120), "extended": (120, MAX_SECONDS)}
SORTS = {
    "relevance": "score",
    "rating": "rating_desc",
    "downloads": "downloads_desc",
    "newest": "created_desc",
    "shortest": "duration_asc",
}
# Our licence code -> the name Freesound's search filter knows it by.
_FILTER_NAMES = {"cc0": "Creative Commons 0", "by": "Attribution"}
_CC0 = re.compile(r"^https?://creativecommons\.org/publicdomain/zero/1\.0/?$")
_BY = re.compile(r"^https?://creativecommons\.org/licenses/by/(\d\.\d)/?$")


class NotAllowed(ProviderError):
    """The sound's licence is not one this server allows."""


@dataclass(frozen=True)
class License:
    code: str  # "cc0" or "by"
    name: str  # "CC0 1.0", "CC BY 4.0"
    url: str


def license_of(url: object) -> License | None:
    """CC0 or CC BY (any version) from Freesound's licence URL; anything else (NC, Sampling+…) is None."""
    if not isinstance(url, str):
        return None
    if _CC0.match(url):
        return License("cc0", "CC0 1.0", "https://creativecommons.org/publicdomain/zero/1.0/")
    match = _BY.match(url)
    if match:
        version = match[1]
        return License("by", f"CC BY {version}", f"https://creativecommons.org/licenses/by/{version}/")
    return None


def allowed_licenses() -> list[str]:
    """`FREESOUND_LICENSES`, cleaned; CC0 alone when it names nothing usable."""
    names = [name.strip().lower() for name in settings.FREESOUND_LICENSES]
    chosen = [name for name in dict.fromkeys(names) if name in _FILTER_NAMES]
    return chosen or ["cc0"]


def configured() -> bool:
    return bool(settings.FREESOUND_API_KEY)


def config() -> stocklimits.StockConfig:
    return stocklimits.config_for(NAME)


def valid_id(sound_id: str) -> bool:
    return _ID.fullmatch(sound_id) is not None


@dataclass(frozen=True)
class Sound:
    id: str
    title: str
    author: str
    author_url: str
    source_url: str
    duration_ms: int
    type: str  # music / effects / ambience / other
    subcategory: str
    license: License
    tags: tuple[str, ...]
    preview_url: str  # low-quality MP3 on the CDN, for listening
    download_url: str  # high-quality OGG on the CDN, for importing

    @property
    def credit_required(self) -> bool:
        return self.license.code != "cc0"

    def credit(self) -> dict[str, Any]:
        return {
            "source": NAME,
            "id": self.id,
            "title": self.title,
            "author": self.author,
            "author_url": self.author_url,
            "url": self.source_url,
            "license": self.license.name,
            "license_url": self.license.url,
            "required": self.credit_required,
        }

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "provider": NAME,
            "title": self.title,
            "author": self.author,
            "author_url": self.author_url,
            "source_url": self.source_url,
            "duration_ms": self.duration_ms,
            "type": self.type,
            "subcategory": self.subcategory,
            "license": self.license.name,
            "license_url": self.license.url,
            "credit_required": self.credit_required,
            "tags": list(self.tags),
        }


def _type_of(category: str) -> str:
    return next((name for name, info in TYPES.items() if info["category"] == category), "other")


def _cdn(url: object) -> str | None:
    try:
        return providers.check_https_host(url, CDN_HOSTS) if isinstance(url, str) else None
    except ProviderError:
        return None


def sound_from(item: object) -> Sound | None:
    """A sound from Freesound's answer, or None when it is malformed or its licence is not allowed here."""
    if not isinstance(item, dict) or not isinstance(item.get("id"), int) or isinstance(item.get("id"), bool):
        return None
    license = license_of(item.get("license"))
    if license is None or license.code not in allowed_licenses():
        return None
    previews = _dict(item.get("previews"))
    preview = _cdn(previews.get("preview-lq-mp3")) or _cdn(previews.get("preview-hq-mp3"))
    download = _cdn(previews.get("preview-hq-ogg")) or _cdn(previews.get("preview-hq-mp3"))
    duration = item.get("duration")
    if not preview or not download or not isinstance(duration, (int, float)):
        return None
    if not 0 < duration <= MAX_SECONDS:
        return None
    author = _as_str(item.get("username"), 100)
    tags = item.get("tags") if isinstance(item.get("tags"), list) else []
    return Sound(
        id=str(item["id"]),
        title=_as_str(item.get("name"), 200).strip() or f"Freesound {item['id']}",
        author=author,
        author_url=f"https://freesound.org/people/{author}/" if _USER.fullmatch(author) else "",
        source_url=_https_link(item.get("url")),
        duration_ms=round(duration * 1000),
        type=_type_of(_as_str(item.get("category"), 60)),
        subcategory=_as_str(item.get("subcategory"), 60),
        license=license,
        tags=tuple(tag[:40] for tag in tags[:12] if isinstance(tag, str)),
        preview_url=preview,
        download_url=download,
    )


def _headers() -> dict[str, str]:
    return {"Authorization": f"Token {settings.FREESOUND_API_KEY}"}


def _note_response(status: int, headers: Mapping[str, str]) -> None:
    if status == 429:
        wait = providers._seconds(headers.get("Retry-After")) or 60
        stocklimits.pause(NAME, wait)
        raise providers.ProviderBusy(int(min(wait, stocklimits.MAX_PAUSE_SECONDS)))


def _api(path: str, params: dict[str, Any] | None = None) -> Any:
    wait = stocklimits.acquire(NAME, config().rate)
    if wait:
        raise providers.ProviderBusy(wait)
    return providers._get_json(f"{API}{path}", headers=_headers(), params=params, on_response=_note_response)


def _quoted(value: str) -> str:
    return '"' + value.replace("\\", "").replace('"', "") + '"'


def search_filter(kind: str, subcategory: str, length: str) -> str:
    """Freesound's `filter`: the allowed licences always, then the tab's choices."""
    licenses = [_quoted(_FILTER_NAMES[name]) for name in allowed_licenses()]
    parts = [f"license:({' OR '.join(licenses)})" if len(licenses) > 1 else f"license:{licenses[0]}"]
    info = TYPES.get(kind)
    if info:
        parts.append(f"category:{_quoted(info['category'])}")
        if subcategory in info["subcategories"]:
            parts.append(f"subcategory:{_quoted(subcategory)}")
    band = LENGTHS.get(length) or (0, MAX_SECONDS)
    parts.append(f"duration:[{band[0]} TO {band[1]}]")
    return " ".join(parts)


@dataclass(frozen=True)
class SoundPage:
    total: int
    next_page: int | None
    sounds: list[Sound]


def remember(sound: Sound) -> None:
    """Kept so a preview or an import right after a search costs no API call."""
    cache.set(f"freesound:sound:{sound.id}", sound, SOUND_CACHE_SECONDS)


def search(
    query: str, kind: str, subcategory: str, length: str, sort: str, page: int, per_page: int
) -> SoundPage:
    params = {
        "query": query[:100],
        "filter": search_filter(kind, subcategory, length),
        "sort": SORTS.get(sort, "score"),
        "page": page,
        "page_size": min(per_page, MAX_PER_PAGE),
        "fields": FIELDS,
    }
    try:
        data = _api("/search/text/", params)
    except ProviderError as exc:
        if str(exc) == "Provider answered 404.":  # a page past the end
            return SoundPage(0, None, [])
        raise
    if not isinstance(data, dict) or not isinstance(data.get("results"), list):
        raise ProviderError("Unexpected provider response.")
    total = _as_int(data.get("count"))
    sounds = [sound for sound in map(sound_from, data["results"]) if sound]
    for sound in sounds:
        remember(sound)
    return SoundPage(total, _next_page(total, page, per_page) if data.get("next") else None, sounds)


def resolve(sound_id: str) -> Sound:
    """The sound with its licence checked again (from the cache of a recent search, else the API)."""
    sound = cache.get(f"freesound:sound:{sound_id}")
    if isinstance(sound, Sound) and sound.license.code in allowed_licenses():
        return sound
    data = _api(f"/sounds/{sound_id}/", {"fields": FIELDS})
    lic = license_of(_dict(data).get("license"))
    if lic is None or lic.code not in allowed_licenses():
        raise NotAllowed("This sound's licence is not allowed here.")
    sound = sound_from(data)
    if sound is None or sound.id != sound_id:
        raise ProviderError("Unexpected provider response.")
    remember(sound)
    return sound


def download(url: str, max_bytes: int) -> bytes:
    return providers.download_image(url, hosts=CDN_HOSTS, max_bytes=max_bytes, accept="audio/*")
