"""The element pack manifest (`backend/data/element_packs.json`): what `sync_element_packs` installs.

The manifest is the single reviewed list of third-party content. Everything that decides what ends up in
the catalogue is data in this file: the exact upstream release (npm packages are pinned to a version and
an integrity hash, plain downloads to a SHA-256 each), the licence, the notice the licence asks to keep,
how to find tags and how to turn the artwork into a recolourable element. Loading validates all of it, and
the licence rules are enforced here: only the SPDX identifiers in `ALLOWED_LICENSES` are accepted (so no
pack whose licence demands visible credit, share-alike terms or custom conditions can be added by mistake).
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from functools import cache
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from django.conf import settings

from .models import ElementKind, ElementStyle
from .normalize import DEFAULT_COLOR, NormalizeSpec

MANIFEST_PATH = Path(settings.BASE_DIR) / "data" / "element_packs.json"
INDEX_DIR = Path(settings.BASE_DIR) / "data" / "element_pack_files"

#: Licences a pack may be distributed under. Every one of them lets Doory redistribute and modify the
#: artwork commercially and asks for nothing the product UI cannot provide (a retained notice, kept in
#: `ElementPack.attribution` and THIRD_PARTY.md). CC-BY, CC-BY-SA, GPL, custom and "free for ..." licences
#: are deliberately absent.
ALLOWED_LICENSES = frozenset(
    {"MIT", "ISC", "Apache-2.0", "OFL-1.1", "CC0-1.0", "BSD-2-Clause", "BSD-3-Clause", "Unlicense"}
)
#: Licences that require the copyright notice to travel with the artwork, so `attribution` is mandatory.
NOTICE_LICENSES = frozenset({"MIT", "ISC", "Apache-2.0", "OFL-1.1", "BSD-2-Clause", "BSD-3-Clause"})

#: Hosts a manifest may download from (HTTPS only, no redirects followed to anywhere else).
ALLOWED_HOSTS = frozenset(
    {
        "registry.npmjs.org",
        "opendoodles.s3-us-west-1.amazonaws.com",
        "cdn.prod.website-files.com",
    }
)

SCHEMA = 1
READERS = ("svg", "iconify-json")
TAG_FORMATS = ("none", "json-map", "tabler", "phosphor-js", "iconify-categories")
GENERATORS = ("graphics",)

_ID = re.compile(r"^[a-z0-9][a-z0-9-]{1,59}$")
_NPM_NAME = re.compile(r"^(?:@[a-z0-9~-][a-z0-9._~-]*/)?[a-z0-9~-][a-z0-9._~-]*$")
_VERSION = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$")
_INTEGRITY = re.compile(r"^sha512-[A-Za-z0-9+/]{86}==$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_STEM = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$")
_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")


class ManifestError(ValueError):
    """The manifest (or one of its pack entries) is not valid."""


@dataclass(frozen=True)
class NpmSource:
    package: str
    version: str
    integrity: str

    @property
    def label(self) -> str:
        return f"{self.package}@{self.version}"

    @property
    def tarball_url(self) -> str:
        base = self.package.rsplit("/", 1)[-1]
        return f"https://registry.npmjs.org/{self.package}/-/{base}-{self.version}.tgz"

    @property
    def tarball_name(self) -> str:
        """File name `npm pack` gives the release (for `--from-dir`)."""
        return f"{self.package.lstrip('@').replace('/', '-')}-{self.version}.tgz"


@dataclass(frozen=True)
class UrlFile:
    name: str
    url: str
    sha256: str
    tags: tuple[str, ...] = ()


@dataclass(frozen=True)
class UrlsSource:
    index: str
    files: tuple[UrlFile, ...]

    @property
    def label(self) -> str:
        return f"{self.index} ({len(self.files)} files)"


@dataclass(frozen=True)
class GeneratedSource:
    generator: str
    set: str

    @property
    def label(self) -> str:
        return f"generated:{self.generator}/{self.set}"


SourceSpec = NpmSource | UrlsSource | GeneratedSource


@dataclass(frozen=True)
class FilesSpec:
    include: tuple[str, ...] = ()
    exclude: tuple[str, ...] = ()
    reader: str = "svg"


@dataclass(frozen=True)
class NamingSpec:
    strip_prefix: str = ""
    strip_suffix: str = ""
    #: Regular expression; icons whose key (after stripping) matches are left out (e.g. skin-tone variants).
    skip: str = ""
    #: Regular expression for brand logos (trademarks): left out unless the sync runs with brand logos on
    #: (`DOORY_ELEMENTS_BRAND_LOGOS`). Kept apart from `skip`, which also holds variants that must always go.
    brand: str = ""


@dataclass(frozen=True)
class TagsSpec:
    format: str = "none"
    file: str = ""


@dataclass(frozen=True)
class LicenseSpec:
    spdx: str
    url: str
    #: A file inside the archive whose text must match `match` (so a release that changes the licence is
    #: refused until someone has read it); empty for sources without such a file.
    file: str = ""
    match: str = ""


@dataclass(frozen=True)
class PackSpec:
    id: str
    name: str
    kind: str
    style: str
    description: str
    homepage: str
    sort_order: int
    source: SourceSpec
    license: LicenseSpec
    attribution: str
    files: FilesSpec = field(default_factory=FilesSpec)
    naming: NamingSpec = field(default_factory=NamingSpec)
    tags: TagsSpec = field(default_factory=TagsSpec)
    normalize: NormalizeSpec = field(default_factory=lambda: NormalizeSpec(mode="mono"))
    fingerprint: str = ""

    @property
    def is_generated(self) -> bool:
        return isinstance(self.source, GeneratedSource)

    @property
    def source_ref(self) -> str:
        return self.source.label

    @property
    def has_brand(self) -> bool:
        return bool(self.naming.brand)

    def fingerprint_for(self, brand_logos: bool) -> str:
        """The fingerprint of a sync with brand logos on or off; unchanged for packs without logos."""
        if not (brand_logos and self.has_brand):
            return self.fingerprint
        return hashlib.sha256(f"{self.fingerprint}:brand-logos".encode()).hexdigest()

    @property
    def patterns(self) -> tuple[str, ...]:
        """Everything that must be taken from the archive for this pack (artwork, tag data, licence)."""
        extra = [p for p in (self.tags.file, self.license.file) if p]
        return (*self.files.include, *extra)


@dataclass(frozen=True)
class Manifest:
    packs: tuple[PackSpec, ...]

    def get(self, pack_id: str) -> PackSpec | None:
        return next((p for p in self.packs if p.id == pack_id), None)

    def select(self, ids: list[str] | None) -> list[PackSpec]:
        """The packs named in `ids` (in manifest order), or all of them; `ManifestError` for unknown ids."""
        if not ids:
            return list(self.packs)
        unknown = [i for i in ids if self.get(i) is None]
        if unknown:
            known = ", ".join(p.id for p in self.packs)
            raise ManifestError(f"Unknown pack id(s): {', '.join(unknown)}. Known packs: {known}.")
        wanted = set(ids)
        return [p for p in self.packs if p.id in wanted]


# ---- validation ------------------------------------------------------------------------------------------


def license_terms(expression: str) -> list[str]:
    """The licence identifiers in an SPDX expression made of `AND`/`OR` (parentheses are not supported)."""
    return [term for term in re.split(r"\s+(?:AND|OR)\s+", expression.strip()) if term]


def is_allowed_license(expression: str) -> bool:
    terms = license_terms(expression)
    return bool(terms) and all(term in ALLOWED_LICENSES for term in terms)


def _expect(cond: bool, message: str) -> None:
    if not cond:
        raise ManifestError(message)


def _only(raw: dict[str, Any], allowed: set[str], where: str) -> None:
    extra = sorted(set(raw) - allowed)
    _expect(not extra, f"{where}: unknown key(s) {', '.join(extra)}")


def _str(raw: dict[str, Any], key: str, where: str, *, required: bool = True, default: str = "") -> str:
    value = raw.get(key, default)
    _expect(isinstance(value, str), f"{where}: {key} must be a string")
    _expect(not required or bool(value.strip()), f"{where}: {key} is required")
    return value.strip()


def _https_url(value: str, where: str, *, hosts: frozenset[str] | None = None) -> str:
    parsed = urlparse(value)
    _expect(
        parsed.scheme == "https" and bool(parsed.hostname) and not parsed.username,
        f"{where}: {value!r} is not an https URL",
    )
    if hosts is not None:
        _expect(parsed.hostname in hosts, f"{where}: host {parsed.hostname!r} is not allowed")
    return value


def _glob_list(raw: dict[str, Any], key: str, where: str) -> tuple[str, ...]:
    value = raw.get(key, [])
    _expect(
        isinstance(value, list) and all(isinstance(v, str) and v for v in value),
        f"{where}: {key} must be a list of globs",
    )
    for pattern in value:
        _expect(
            not pattern.startswith("/") and ".." not in pattern.split("/"),
            f"{where}: {key} pattern {pattern!r} must be relative",
        )
    return tuple(value)


def _load_index(name: str, where: str) -> tuple[UrlFile, ...]:
    _expect(bool(_STEM.match(name)) and name.endswith(".json"), f"{where}: index must be a .json file name")
    path = INDEX_DIR / name
    _expect(path.is_file(), f"{where}: index file {name} not found in {INDEX_DIR}")
    try:
        rows = json.loads(path.read_text(encoding="utf-8"))
    except ValueError as exc:
        raise ManifestError(f"{where}: {name} is not valid JSON") from exc
    _expect(isinstance(rows, list) and rows, f"{where}: {name} must be a non-empty list")
    files: list[UrlFile] = []
    seen: set[str] = set()
    for index, row in enumerate(rows):
        spot = f"{where}: {name}[{index}]"
        _expect(isinstance(row, dict), f"{spot} must be an object")
        _only(row, {"name", "url", "sha256", "tags"}, spot)
        file_name = _str(row, "name", spot)
        _expect(bool(_STEM.match(file_name)) and file_name.endswith(".svg"), f"{spot}: bad file name")
        _expect(file_name not in seen, f"{spot}: duplicate name {file_name}")
        seen.add(file_name)
        digest = _str(row, "sha256", spot)
        _expect(bool(_SHA256.match(digest)), f"{spot}: sha256 must be 64 lower-case hex digits")
        tags = row.get("tags", [])
        _expect(
            isinstance(tags, list) and all(isinstance(t, str) for t in tags), f"{spot}: tags must be strings"
        )
        files.append(
            UrlFile(
                name=file_name,
                url=_https_url(_str(row, "url", spot), spot, hosts=ALLOWED_HOSTS),
                sha256=digest,
                tags=tuple(tags),
            )
        )
    return tuple(files)


def _source(raw: Any, where: str) -> SourceSpec:
    _expect(isinstance(raw, dict), f"{where}: source must be an object")
    kind = raw.get("type")
    if kind == "npm":
        _only(raw, {"type", "package", "version", "integrity"}, f"{where}: source")
        package, version = _str(raw, "package", where), _str(raw, "version", where)
        integrity = _str(raw, "integrity", where)
        _expect(bool(_NPM_NAME.match(package)), f"{where}: {package!r} is not an npm package name")
        _expect(bool(_VERSION.match(version)), f"{where}: version must be exact (e.g. 1.2.3), not a range")
        _expect(bool(_INTEGRITY.match(integrity)), f"{where}: integrity must be an npm sha512 value")
        return NpmSource(package=package, version=version, integrity=integrity)
    if kind == "urls":
        _only(raw, {"type", "index"}, f"{where}: source")
        index = _str(raw, "index", where)
        return UrlsSource(index=index, files=_load_index(index, where))
    if kind == "generated":
        _only(raw, {"type", "generator", "set"}, f"{where}: source")
        generator = _str(raw, "generator", where)
        _expect(generator in GENERATORS, f"{where}: unknown generator {generator!r}")
        return GeneratedSource(generator=generator, set=_str(raw, "set", where))
    raise ManifestError(f"{where}: source.type must be npm, urls or generated")


def _license(raw: Any, where: str) -> LicenseSpec:
    _expect(isinstance(raw, dict), f"{where}: license must be an object")
    _only(raw, {"spdx", "url", "file", "match"}, f"{where}: license")
    spdx = _str(raw, "spdx", where)
    _expect(
        is_allowed_license(spdx),
        f"{where}: licence {spdx!r} is not allowed (allowed: {', '.join(sorted(ALLOWED_LICENSES))})",
    )
    file, match = _str(raw, "file", where, required=False), _str(raw, "match", where, required=False)
    _expect(bool(file) == bool(match), f"{where}: license.file and license.match go together")
    if match:
        try:
            re.compile(match)
        except re.error as exc:
            raise ManifestError(f"{where}: license.match is not a valid regular expression") from exc
    return LicenseSpec(spdx=spdx, url=_https_url(_str(raw, "url", where), where), file=file, match=match)


def _normalize(raw: Any, where: str) -> NormalizeSpec:
    _expect(isinstance(raw, dict), f"{where}: normalize must be an object")
    _only(raw, {"mode", "color", "size", "frame"}, f"{where}: normalize")
    mode = _str(raw, "mode", where)
    _expect(mode in ("mono", "colour"), f"{where}: normalize.mode must be mono or colour")
    color = _str(raw, "color", where, required=False, default=DEFAULT_COLOR)
    _expect(bool(_COLOR.match(color)), f"{where}: normalize.color must be #rrggbb")
    size = raw.get("size")
    _expect(
        size is None or (isinstance(size, (int, float)) and not isinstance(size, bool) and 1 <= size <= 4096),
        f"{where}: normalize.size must be a number between 1 and 4096",
    )
    frame = raw.get("frame", False)
    _expect(isinstance(frame, bool), f"{where}: normalize.frame must be true or false")
    return NormalizeSpec(mode=mode, color=color.lower(), size=float(size) if size else None, frame=frame)


def _fingerprint(raw: dict[str, Any], source: SourceSpec) -> str:
    from .normalize import NORMALIZER_VERSION

    payload = {"pack": raw, "normalizer": NORMALIZER_VERSION}
    if isinstance(source, UrlsSource):
        payload["files"] = [(f.name, f.url, f.sha256, f.tags) for f in source.files]
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def parse_pack(raw: Any) -> PackSpec:
    _expect(isinstance(raw, dict), "every pack must be an object")
    where = str(raw.get("id", "?"))
    _only(
        raw,
        {
            "id",
            "name",
            "kind",
            "style",
            "description",
            "homepage",
            "sort_order",
            "source",
            "files",
            "naming",
            "tags",
            "normalize",
            "license",
            "attribution",
        },
        where,
    )
    pack_id = _str(raw, "id", where)
    _expect(bool(_ID.match(pack_id)), f"{where}: id must be lower-case letters, digits and hyphens")
    kind = _str(raw, "kind", where)
    _expect(kind in ElementKind.values, f"{where}: kind must be one of {', '.join(ElementKind.values)}")
    style = _str(raw, "style", where, required=False)
    _expect(not style or style in ElementStyle.values, f"{where}: style must be one of {ElementStyle.values}")
    sort_order = raw.get("sort_order", 0)
    _expect(
        isinstance(sort_order, int) and not isinstance(sort_order, bool) and sort_order >= 0,
        f"{where}: sort_order must be a non-negative integer",
    )
    source = _source(raw.get("source"), where)
    license_spec = _license(raw.get("license"), where)
    attribution = _str(raw, "attribution", where, required=False)
    if any(term in NOTICE_LICENSES for term in license_terms(license_spec.spdx)):
        _expect(bool(attribution), f"{where}: licence {license_spec.spdx} requires an attribution notice")
    homepage = _str(raw, "homepage", where, required=False)
    if homepage:
        _https_url(homepage, where)

    files, naming, tags = FilesSpec(), NamingSpec(), TagsSpec()
    normalize = NormalizeSpec(mode="mono")
    if isinstance(source, GeneratedSource):
        _expect(
            not {"files", "naming", "tags", "normalize"} & set(raw),
            f"{where}: generated packs take no files/naming/tags/normalize",
        )
        _expect(not license_spec.file, f"{where}: generated packs have no licence file to check")
    else:
        files_raw = raw.get("files")
        _expect(isinstance(files_raw, dict), f"{where}: files must be an object")
        _only(files_raw, {"include", "exclude", "reader"}, f"{where}: files")
        reader = _str(files_raw, "reader", where, required=False, default="svg")
        _expect(reader in READERS, f"{where}: files.reader must be one of {', '.join(READERS)}")
        include = _glob_list(files_raw, "include", where)
        _expect(bool(include), f"{where}: files.include needs at least one glob")
        files = FilesSpec(include=include, exclude=_glob_list(files_raw, "exclude", where), reader=reader)
        naming_raw = raw.get("naming", {})
        _expect(isinstance(naming_raw, dict), f"{where}: naming must be an object")
        _only(naming_raw, {"strip_prefix", "strip_suffix", "skip", "brand"}, f"{where}: naming")
        skip = _str(naming_raw, "skip", where, required=False)
        brand = _str(naming_raw, "brand", where, required=False)
        for key, pattern in (("skip", skip), ("brand", brand)):
            try:
                re.compile(pattern)
            except re.error as exc:
                raise ManifestError(f"{where}: naming.{key} is not a valid regular expression") from exc
        naming = NamingSpec(
            strip_prefix=_str(naming_raw, "strip_prefix", where, required=False),
            strip_suffix=_str(naming_raw, "strip_suffix", where, required=False),
            skip=skip,
            brand=brand,
        )
        tags_raw = raw.get("tags", {})
        _expect(isinstance(tags_raw, dict), f"{where}: tags must be an object")
        _only(tags_raw, {"format", "file"}, f"{where}: tags")
        fmt = _str(tags_raw, "format", where, required=False, default="none")
        _expect(fmt in TAG_FORMATS, f"{where}: tags.format must be one of {', '.join(TAG_FORMATS)}")
        tag_file = _str(tags_raw, "file", where, required=False)
        _expect(
            (fmt == "none") == (not tag_file), f"{where}: tags.file is needed exactly when tags.format is set"
        )
        tags = TagsSpec(format=fmt, file=tag_file)
        normalize = _normalize(raw.get("normalize"), where)
        if isinstance(source, NpmSource):
            _expect(bool(license_spec.file), f"{where}: npm packs must name a licence file to check")
        else:
            _expect(reader == "svg", f"{where}: url packs hold plain SVG files")
    return PackSpec(
        id=pack_id,
        name=_str(raw, "name", where),
        kind=kind,
        style=style,
        description=_str(raw, "description", where, required=False),
        homepage=homepage,
        sort_order=sort_order,
        source=source,
        license=license_spec,
        attribution=attribution,
        files=files,
        naming=naming,
        tags=tags,
        normalize=normalize,
        fingerprint=_fingerprint(raw, source),
    )


def parse_manifest(raw: Any) -> Manifest:
    _expect(isinstance(raw, dict), "the manifest must be a JSON object")
    _only(raw, {"schema", "packs"}, "manifest")
    _expect(raw.get("schema") == SCHEMA, f"manifest: schema must be {SCHEMA}")
    packs_raw = raw.get("packs")
    _expect(isinstance(packs_raw, list) and packs_raw, "manifest: packs must be a non-empty list")
    packs = tuple(parse_pack(item) for item in packs_raw)
    ids = [p.id for p in packs]
    _expect(len(ids) == len(set(ids)), "manifest: pack ids must be unique")
    return Manifest(packs=packs)


@cache
def load_manifest(path: Path = MANIFEST_PATH) -> Manifest:
    """Read and validate the manifest; `ManifestError` explains what is wrong with it."""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ManifestError(f"Cannot read {path}: {exc.strerror or exc}") from exc
    except ValueError as exc:
        raise ManifestError(f"{path} is not valid JSON: {exc}") from exc
    return parse_manifest(raw)
