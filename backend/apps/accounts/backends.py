"""Authentication backend that applies the per-account lockout to every password login.

`LoginView` and the Django admin both go through `authenticate()`, so guarding the backend protects
both. While an account is locked the backend refuses to even check the password (`PermissionDenied`
makes `authenticate()` return `None`, exactly like a wrong password).
"""

from __future__ import annotations

from django.contrib.auth.backends import ModelBackend
from django.core.exceptions import PermissionDenied
from rest_framework.exceptions import Throttled

from .lockout import PasswordAttemptGuard
from .models import User


class GuardedModelBackend(ModelBackend):
    def authenticate(self, request, username=None, password=None, **kwargs):
        identifier = username if username is not None else kwargs.get(User.USERNAME_FIELD)
        if not identifier or password is None:
            return None
        guard = PasswordAttemptGuard(identifier)
        try:
            guard.check()
        except Throttled:
            raise PermissionDenied from None
        user = super().authenticate(request, username=username, password=password, **kwargs)
        if user is None:
            guard.record_failure()
        else:
            guard.reset()
        return user
