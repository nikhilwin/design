"""Who is calling: set by `auth.TokenAuthMiddleware` for the duration of one HTTP request."""

from __future__ import annotations

import contextvars
from dataclasses import dataclass

from apps.accounts.models import User
from apps.apitokens.models import ApiToken


@dataclass(frozen=True)
class Caller:
    user: User
    token: ApiToken

    def has(self, scope: str) -> bool:
        return scope in self.token.scopes

    @property
    def label(self) -> str:
        """How the caller shows up in version labels and logs."""
        return self.token.name


_current: contextvars.ContextVar[Caller | None] = contextvars.ContextVar("doory_mcp_caller", default=None)


def current() -> Caller | None:
    return _current.get()


def bind(caller: Caller) -> contextvars.Token:
    return _current.set(caller)


def unbind(token: contextvars.Token) -> None:
    _current.reset(token)
