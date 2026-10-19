"""Template fields: objects tagged with a stable key (`field` on an object) that data can be filled in by.

The rules match the editor's (`frontend/src/editor/engine/fields.ts`): a key is `[a-z][a-z0-9_]{0,39}` and
names one value. It is used at most once per page; the same key on several pages is the same value there, so
it must have the same type everywhere.
"""

from __future__ import annotations

import math
import re
from collections.abc import Iterator
from typing import Annotated, Any, Literal

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, StringConstraints

from . import builders
from .kinds import object_kind

FIELD_KEY = re.compile(r"[a-z][a-z0-9_]{0,39}")
FIELD_TYPES = ("text", "image", "color")
LABEL_MAX = 80

FieldType = Literal["text", "image", "color"]
# The field type each object kind can hold; other kinds can't be fields.
KIND_TYPES: dict[str, str] = {"text": "text", "image": "image", "placeholder": "image", "shape": "color"}


class FieldTag(BaseModel):
    """A template field tag: `key` names the value, `type` what it holds, `label` is shown when filling."""

    model_config = ConfigDict(extra="forbid")

    key: Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_]{0,39}$")] = Field(
        description="1-40 characters: a-z, 0-9 and _, starting with a letter. Unique per page; the same key "
        "on several pages is the same value there."
    )
    type: FieldType = Field(description="text (text boxes), image (pictures, placeholders), color (shapes).")
    label: Annotated[str, StringConstraints(strip_whitespace=True, max_length=LABEL_MAX)] | None = None

    def document(self) -> dict:
        return {"key": self.key, "type": self.type, **({"label": self.label} if self.label else {})}


class TextFit(BaseModel):
    """Shrink-to-fit text: the box height stays fixed while the font steps down to fit."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    mode: Literal["shrink"] = "shrink"
    min_font_size: Annotated[float, Field(ge=builders.MIN_FONT_SIZE, le=builders.MAX_FONT_SIZE)] | None = (
        Field(
            None,
            validation_alias=AliasChoices("min_font_size", "minFontSize"),
            description="Smallest font size to shrink to (px). Default: half the font size.",
        )
    )

    def document(self) -> dict:
        out: dict = {"mode": self.mode}
        if self.min_font_size is not None:
            out["minFontSize"] = builders._num(self.min_font_size)
        return out


def read_field(value: Any) -> dict | None:
    """The tag when it is well formed, else None (a malformed tag is ignored, like the editor does)."""
    if not isinstance(value, dict):
        return None
    key, kind = value.get("key"), value.get("type")
    if not isinstance(key, str) or not FIELD_KEY.fullmatch(key) or kind not in FIELD_TYPES:
        return None
    label = value.get("label")
    return {"key": key, "type": kind, **({"label": label} if isinstance(label, str) and label else {})}


def read_fit(value: Any) -> dict | None:
    """The shrink-to-fit setting when it is well formed, else None."""
    if not isinstance(value, dict) or value.get("mode") != "shrink":
        return None
    min_size = value.get("minFontSize")
    if (
        isinstance(min_size, int | float)
        and not isinstance(min_size, bool)
        and math.isfinite(min_size)
        and min_size >= builders.MIN_FONT_SIZE
    ):
        clamped = min(float(builders.MAX_FONT_SIZE), float(min_size))
        return {"mode": "shrink", "minFontSize": builders._num(clamped)}
    return {"mode": "shrink"}


def text_overflows(obj: dict) -> bool:
    """True when a shrink-to-fit text still does not fit inside its box at `minFontSize`."""
    fit = read_fit(obj.get("fit"))
    size = builders.valid_font_size(obj.get("fontSize", 40.0))
    if not fit or size is None:
        return False
    text = str(obj.get("text", ""))
    width = builders._pos_float(obj.get("width"), 200.0)
    leading = builders._pos_float(obj.get("lineHeight"), 1.16)
    height = builders._pos_float(obj.get("height"), builders.text_height(1, size, leading))
    weight = int(builders._pos_float(obj.get("fontWeight"), 400.0))
    min_size = fit.get("minFontSize")
    fitted = builders.fit_font_size(
        text,
        width,
        height,
        size,
        weight,
        leading,
        float(min_size) if isinstance(min_size, int | float) else None,
    )
    lines = builders.estimate_text_lines(text, width, fitted, weight)
    return builders.text_height(lines, fitted, leading) > height + 1e-3


def _walk(objects: Any) -> Iterator[dict]:
    """Every object of a list, nested group members too, without recursion."""
    stack = [iter(objects if isinstance(objects, list) else [])]
    while stack:
        obj = next(stack[-1], None)
        if obj is None:
            stack.pop()
            continue
        if isinstance(obj, dict):
            yield obj
            if isinstance(obj.get("objects"), list):
                stack.append(iter(obj["objects"]))


def tagged(document: dict) -> Iterator[tuple[int, dict, dict]]:
    """(page number, object, tag) for every tagged object, in page and stack order."""
    for number, page in enumerate(document.get("pages") or [], start=1):
        if isinstance(page, dict):
            for obj in _walk(page.get("objects")):
                tag = read_field(obj.get("field"))
                if tag:
                    yield number, obj, tag


def duplicate_keys(document: dict) -> list[str]:
    """Keys used twice on one page or with different types, sorted."""
    types: dict[str, str] = {}
    seen: set[tuple[int, str]] = set()
    bad: set[str] = set()
    for number, _obj, tag in tagged(document):
        key = tag["key"]
        if (number, key) in seen or types.get(key, tag["type"]) != tag["type"]:
            bad.add(key)
        seen.add((number, key))
        types.setdefault(key, tag["type"])
    return sorted(bad)


def _current(obj: dict, field_type: str) -> Any:
    if field_type == "text":
        return str(obj.get("text", ""))
    if field_type == "image":
        return {"asset_id": obj.get("assetId"), "url": obj.get("docSrc") or obj.get("src")}
    fill = obj.get("fill")
    return fill if isinstance(fill, str) else None


def list_fields(document: dict) -> list[dict]:
    """The fields of a design, one entry per key, in first-use order. Photo placeholders without a tag are
    listed too, as suggested image fields with `key: null` (one entry each). A later tag that clashes (same
    key on the same page, or another type on a later page) is dropped."""
    fields: dict[str, dict] = {}
    out: list[dict] = []
    for number, page in enumerate(document.get("pages") or [], start=1):
        if not isinstance(page, dict):
            continue
        for obj in _walk(page.get("objects")):
            tag = read_field(obj.get("field"))
            if tag is None:
                if object_kind(obj) == "placeholder":
                    out.append(_entry(None, "image", None, obj, number))
                continue
            entry = fields.get(tag["key"])
            if entry is None:
                entry = fields[tag["key"]] = _entry(tag["key"], tag["type"], tag.get("label"), obj, number)
                out.append(entry)
            elif entry["type"] == tag["type"] and number not in entry["pages"]:
                entry["object_ids"].append(obj.get("id"))
                entry["pages"].append(number)
                if tag["type"] == "text":
                    if entry["fit"] is None:
                        entry["fit"] = read_fit(obj.get("fit"))
                    if text_overflows(obj):
                        entry["overflow"] = True
    return out


def _entry(key: str | None, field_type: str, label: str | None, obj: dict, page: int) -> dict:
    return {
        "key": key,
        "type": field_type,
        "label": label,
        "pages": [page],
        "object_ids": [obj.get("id")],
        "current": _current(obj, field_type),
        "fit": read_fit(obj.get("fit")) if field_type == "text" else None,
        "overflow": text_overflows(obj) if field_type == "text" else False,
    }
