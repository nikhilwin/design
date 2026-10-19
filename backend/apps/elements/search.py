"""Search text normalisation and relevance ranking for the element catalogue.

Every element carries two denormalised, accent-folded, lower-case columns (`search_name`, `search_tags`)
that `Element.save()` and `bulk_import` keep in step with `name` and `tags`. Queries then match with plain
`LIKE` comparisons (which PostgreSQL can serve from a trigram index, see migration 0002) and rank with a
`CASE` expression instead of loading rows into Python, so a search touches the database only twice
(count + page) regardless of catalogue size.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable, Sequence

from django.db.models import Case, Expression, IntegerField, Value, When

MAX_SEARCH_WORDS = 8
MAX_WORD_LENGTH = 40
MAX_TAGS = 30
MAX_TAG_LENGTH = 40

_SPACES = re.compile(r"\s+")

# Score of the best way a query word matches an element, summed over the words of the query.
SCORE_NAME_EXACT = 300
SCORE_NAME_PREFIX = 200
SCORE_NAME_WORD_PREFIX = 150
SCORE_NAME_CONTAINS = 100
SCORE_TAG_EXACT = 60
SCORE_TAG_PREFIX = 40
SCORE_TAG_CONTAINS = 20
# Bonuses when the whole (multi-word) query matches the name as a phrase.
SCORE_PHRASE_EXACT = 1000
SCORE_PHRASE_PREFIX = 500
SCORE_PHRASE_CONTAINS = 150


def fold(text: str) -> str:
    """Lower-case, accent-free, single-spaced form of `text` (what the search columns hold)."""
    decomposed = unicodedata.normalize("NFKD", str(text))
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return _SPACES.sub(" ", stripped.casefold()).strip()


def search_name(name: str) -> str:
    return fold(name)


def search_tags(tags: Iterable[object]) -> str:
    """` tag one  tag two ` — every tag folded, the whole string padded so ` tag ` matches whole tags."""
    folded = [fold(str(tag)) for tag in tags]
    folded = [tag for tag in dict.fromkeys(folded) if tag]
    return f" {' '.join(folded)} " if folded else ""


def clean_tags(candidates: Iterable[object], limit: int = MAX_TAGS) -> list[str]:
    """Display tags: lower-cased, de-duplicated, short, at most `limit` of them (order is kept)."""
    out: dict[str, None] = {}
    for candidate in candidates:
        tag = _SPACES.sub(" ", str(candidate).strip().lower())
        if tag and len(tag) <= MAX_TAG_LENGTH and not tag.startswith("*"):
            out[tag] = None
        if len(out) >= limit:
            break
    return list(out)


def split_query(text: str) -> list[str]:
    """The distinct words of a search string, folded, at most `MAX_SEARCH_WORDS` of them."""
    words: dict[str, None] = {}
    for word in fold(text).split(" "):
        if word:
            words[word[:MAX_WORD_LENGTH]] = None
        if len(words) >= MAX_SEARCH_WORDS:
            break
    return list(words)


def _word_score(word: str) -> Expression:
    return Case(
        When(search_name=word, then=Value(SCORE_NAME_EXACT)),
        When(search_name__startswith=word, then=Value(SCORE_NAME_PREFIX)),
        When(search_name__contains=f" {word}", then=Value(SCORE_NAME_WORD_PREFIX)),
        When(search_name__contains=word, then=Value(SCORE_NAME_CONTAINS)),
        When(search_tags__contains=f" {word} ", then=Value(SCORE_TAG_EXACT)),
        When(search_tags__contains=f" {word}", then=Value(SCORE_TAG_PREFIX)),
        When(search_tags__contains=word, then=Value(SCORE_TAG_CONTAINS)),
        default=Value(0),
        output_field=IntegerField(),
    )


def relevance_expression(words: Sequence[str]) -> Expression:
    """SQL score of an element for the query `words` (higher is better); needs the search columns."""
    total: Expression = Value(0, output_field=IntegerField())
    for word in words:
        total = total + _word_score(word)
    if len(words) > 1:
        phrase = " ".join(words)
        total = total + Case(
            When(search_name=phrase, then=Value(SCORE_PHRASE_EXACT)),
            When(search_name__startswith=phrase, then=Value(SCORE_PHRASE_PREFIX)),
            When(search_name__contains=phrase, then=Value(SCORE_PHRASE_CONTAINS)),
            default=Value(0),
            output_field=IntegerField(),
        )
    return total
