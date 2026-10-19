from django.contrib.auth.base_user import AbstractBaseUser, BaseUserManager
from django.contrib.auth.models import PermissionsMixin
from django.db import models
from django.db.models.functions import Lower

from apps.core.models import BaseModel


class UserManager(BaseUserManager):
    use_in_migrations = True

    def get_by_natural_key(self, email):
        """Case-insensitive login lookup (emails are stored lower-case; this also covers legacy rows)."""
        return self.get(email__iexact=(email or "").strip())

    def _create_user(self, email, password, **extra):
        if not email:
            raise ValueError("An email address is required.")
        user = self.model(email=self.normalize_email(email).lower(), **extra)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_user(self, email, password=None, **extra):
        extra.setdefault("is_staff", False)
        extra.setdefault("is_superuser", False)
        return self._create_user(email, password, **extra)

    def create_superuser(self, email, password=None, **extra):
        extra.setdefault("is_staff", True)
        extra.setdefault("is_superuser", True)
        extra.setdefault("is_email_verified", True)
        return self._create_user(email, password, **extra)


class User(BaseModel, AbstractBaseUser, PermissionsMixin):
    email = models.EmailField(unique=True)
    display_name = models.CharField(max_length=80, blank=True)
    avatar = models.ImageField(upload_to="avatars/", blank=True)
    google_sub = models.CharField(max_length=64, unique=True, null=True, blank=True)
    is_email_verified = models.BooleanField(default=False)
    is_active = models.BooleanField(default=True)
    is_staff = models.BooleanField(default=False)

    objects = UserManager()
    USERNAME_FIELD = "email"
    REQUIRED_FIELDS: list[str] = []

    class Meta:
        constraints = [models.UniqueConstraint(Lower("email"), name="accounts_user_email_ci_unique")]

    def __str__(self):
        return self.email

    def save(self, *args, **kwargs):
        self.email = self.email.strip().lower()
        super().save(*args, **kwargs)

    def check_password(self, raw_password):
        # A correct password may be re-hashed on the spot (a hasher upgrade). It is the same password, so
        # API tokens bound to the old hash carry over instead of dying.
        old = self.password
        valid = super().check_password(raw_password)
        if valid and self.password != old:
            from apps.apitokens.services import rebind

            rebind(self, old)
        return valid

    async def acheck_password(self, raw_password):
        from asgiref.sync import sync_to_async

        return await sync_to_async(self.check_password)(raw_password)

    @property
    def name(self) -> str:
        return self.display_name or self.email.split("@")[0]
