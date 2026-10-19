"""`/auth/*` endpoints.

Every unsafe endpoint enforces CSRF (`CsrfProtectedMixin`), including the anonymous ones, and the
credential-handling ones share the per-IP `auth` throttle scope.
"""

from __future__ import annotations

from django.conf import settings
from django.contrib.auth import authenticate, login, logout, update_session_auth_hash
from django.db import IntegrityError, transaction
from django.middleware.csrf import get_token
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework import status
from rest_framework.exceptions import ErrorDetail, Throttled, ValidationError
from rest_framework.generics import GenericAPIView
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle, ScopedRateThrottle, UserRateThrottle
from rest_framework.views import APIView

from apps.apitokens.services import revoke_all as revoke_all_tokens
from apps.core.csrf import CsrfProtectedMixin
from apps.core.exceptions import ApiError
from apps.core.images import ImageError
from apps.core.parsers import BoundedJSONParser

from .emails import send_password_reset_email, send_verification_email
from .google import GoogleSignInError, verify_google_credential
from .lockout import PasswordAttemptGuard, claim_email_slot
from .models import User
from .serializers import (
    DeleteAccountSerializer,
    EmailVerifySerializer,
    GoogleLoginSerializer,
    GoogleResultSerializer,
    LoginSerializer,
    OptionalUserEnvelopeSerializer,
    PasswordChangeSerializer,
    PasswordResetConfirmSerializer,
    PasswordResetRequestSerializer,
    ProfileUpdateSerializer,
    RegisterSerializer,
    UserEnvelopeSerializer,
    UserSerializer,
    check_new_password,
)
from .services import build_avatar, replace_avatar, sign_in_with_google
from .tokens import (
    decode_uid,
    email_verification_token_generator,
    password_reset_token_generator,
)

TAGS = ["auth"]
NO_CONTENT = OpenApiResponse(description="Done; no body.")


def _user_payload(user: User) -> dict:
    return {"user": UserSerializer(user).data}


def _field_error(field: str, message: str, code: str) -> ValidationError:
    return ValidationError({field: [ErrorDetail(message, code=code)]})


class AuthView(CsrfProtectedMixin, GenericAPIView):
    """Base for the credential endpoints: CSRF-protected, per-IP `auth` throttle."""

    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "auth"
    permission_classes = [AllowAny]


@extend_schema(responses={204: NO_CONTENT}, tags=TAGS)
class CsrfView(APIView):
    """Sets the `csrftoken` cookie; the SPA echoes it in `X-CSRFToken` on unsafe requests."""

    permission_classes = [AllowAny]
    authentication_classes: list = []

    def get(self, request):
        get_token(request)
        return Response(status=status.HTTP_204_NO_CONTENT)


@extend_schema(request=RegisterSerializer, responses={201: UserEnvelopeSerializer}, tags=TAGS)
class RegisterView(AuthView):
    serializer_class = RegisterSerializer

    def post(self, request):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        try:
            with transaction.atomic():
                user = User.objects.create_user(
                    data["email"], data["password"], display_name=data.get("display_name", "")
                )
        except IntegrityError:  # lost a race with a concurrent registration of the same address
            raise _field_error("email", "An account with this email already exists.", "email_taken") from None
        send_verification_email(user)
        login(request, user)
        return Response(_user_payload(user), status=status.HTTP_201_CREATED)


@extend_schema(request=LoginSerializer, responses={200: UserEnvelopeSerializer}, tags=TAGS)
class LoginView(AuthView):
    serializer_class = LoginSerializer

    def post(self, request):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        email = serializer.validated_data["email"]
        PasswordAttemptGuard(email).check()  # a locked account answers 429, not "wrong password"
        # Unknown emails, wrong passwords and disabled accounts are indistinguishable by design. The
        # backend counts the failure towards the account lockout.
        user = authenticate(request, username=email, password=serializer.validated_data["password"])
        if user is None:
            raise ApiError("invalid_credentials", "Incorrect email or password.")
        login(request, user)
        return Response(_user_payload(user))


@extend_schema(request=None, responses={204: NO_CONTENT}, tags=TAGS)
class LogoutView(AuthView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        logout(request)
        return Response(status=status.HTTP_204_NO_CONTENT)


class MeView(CsrfProtectedMixin, GenericAPIView):
    """The current user. `GET` never fails for anonymous callers so the SPA can bootstrap."""

    parser_classes = [BoundedJSONParser, MultiPartParser, FormParser]
    throttle_classes = [AnonRateThrottle, UserRateThrottle, ScopedRateThrottle]
    serializer_class = ProfileUpdateSerializer

    @property
    def throttle_scope(self) -> str | None:
        return {"PATCH": "upload", "DELETE": "auth"}.get(self.request.method)

    def get_permissions(self):
        return [AllowAny() if self.request.method == "GET" else IsAuthenticated()]

    @extend_schema(responses={200: OptionalUserEnvelopeSerializer}, tags=TAGS)
    def get(self, request):
        return Response(
            {"user": UserSerializer(request.user).data if request.user.is_authenticated else None}
        )

    @extend_schema(request=ProfileUpdateSerializer, responses={200: UserEnvelopeSerializer}, tags=TAGS)
    def patch(self, request):
        serializer = ProfileUpdateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        user = request.user

        avatar_bytes: bytes | None = None
        if upload := data.get("avatar"):
            try:
                avatar_bytes = build_avatar(upload, max_bytes=settings.MAX_AVATAR_BYTES)
            except ImageError as exc:
                raise _field_error("avatar", str(exc), "invalid_image") from exc

        if "display_name" in data:
            user.display_name = data["display_name"]
            user.save(update_fields=["display_name", "updated_at"])
        if avatar_bytes is not None:
            replace_avatar(user, avatar_bytes)
        elif data.get("remove_avatar"):
            replace_avatar(user, None)
        return Response(_user_payload(user))

    @extend_schema(request=DeleteAccountSerializer, responses={204: NO_CONTENT}, tags=TAGS)
    def delete(self, request):
        serializer = DeleteAccountSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        user = request.user

        confirm_identity(user, data)
        others = User.objects.filter(is_superuser=True, is_active=True).exclude(pk=user.pk)
        if user.is_superuser and not others.exists():
            raise ApiError("last_superuser", "The last administrator account cannot be deleted here.")

        user.delete()  # cascades to the user's data; the avatar file is removed after commit
        logout(request)
        return Response(status=status.HTTP_204_NO_CONTENT)


def confirm_identity(user: User, data: dict) -> None:
    """Ask a signed-in user to prove it is them before a sensitive step: their password, or for accounts
    without one (Google), their email address typed out. `data` holds `password` / `confirm_email`."""
    if user.has_usable_password():
        _verify_password(user, data.get("password", ""), "password")
    elif data.get("confirm_email", "").strip().lower() != user.email.lower():
        raise _field_error(
            "confirm_email", "Type your account's email address to confirm.", "confirm_email_mismatch"
        )


def _verify_password(user: User, password: str, field: str) -> None:
    """Check `password` for a signed-in user; failures count towards the account lockout."""
    guard = PasswordAttemptGuard(user.email)
    guard.check()
    if not user.check_password(password):
        guard.record_failure()
        raise _field_error(field, "Incorrect password.", "invalid_password")
    guard.reset()


@extend_schema(request=PasswordChangeSerializer, responses={204: NO_CONTENT}, tags=TAGS)
class PasswordChangeView(AuthView):
    permission_classes = [IsAuthenticated]
    serializer_class = PasswordChangeSerializer

    def post(self, request):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = request.user
        if user.has_usable_password():  # accounts without a password (Google) may set a first one
            _verify_password(user, serializer.validated_data.get("old_password", ""), "old_password")
        new_password = serializer.validated_data["new_password"]
        check_new_password(new_password, user)
        user.set_password(new_password)
        user.save(update_fields=["password", "updated_at"])
        update_session_auth_hash(request, user)  # this session stays valid; every other one is dropped
        revoke_all_tokens(user)  # a token minted by whoever knew the old password must not outlive it
        return Response(status=status.HTTP_204_NO_CONTENT)


@extend_schema(request=PasswordResetRequestSerializer, responses={204: NO_CONTENT}, tags=TAGS)
class PasswordResetView(AuthView):
    """Always answers 204 so the endpoint cannot be used to discover which emails have accounts."""

    serializer_class = PasswordResetRequestSerializer

    def post(self, request):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        email = serializer.validated_data["email"]
        if claim_email_slot(email, "reset"):  # claimed for unknown addresses too: same behaviour
            user = User.objects.filter(email__iexact=email, is_active=True).first()
            if user is not None:
                send_password_reset_email(user)
        return Response(status=status.HTTP_204_NO_CONTENT)


def _invalid_link() -> ApiError:
    return ApiError("invalid_token", "This link is invalid or has expired.")


@extend_schema(request=PasswordResetConfirmSerializer, responses={204: NO_CONTENT}, tags=TAGS)
class PasswordResetConfirmView(AuthView):
    serializer_class = PasswordResetConfirmSerializer

    def post(self, request):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        user = decode_uid(data["uid"])
        if user is None or not password_reset_token_generator.check_token(user, data["token"]):
            raise _invalid_link()
        check_new_password(data["new_password"], user)
        user.set_password(data["new_password"])
        user.is_email_verified = True  # the reset link proves control of the mailbox
        user.save(update_fields=["password", "is_email_verified", "updated_at"])
        PasswordAttemptGuard(user.email).reset()
        revoke_all_tokens(user)
        return Response(status=status.HTTP_204_NO_CONTENT)


@extend_schema(request=EmailVerifySerializer, responses={204: NO_CONTENT}, tags=TAGS)
class EmailVerifyView(AuthView):
    serializer_class = EmailVerifySerializer

    def post(self, request):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        user = decode_uid(data["uid"])
        if user is None or not email_verification_token_generator.check_token(user, data["token"]):
            raise _invalid_link()
        user.is_email_verified = True
        user.save(update_fields=["is_email_verified", "updated_at"])
        return Response(status=status.HTTP_204_NO_CONTENT)


@extend_schema(request=None, responses={204: NO_CONTENT}, tags=TAGS)
class EmailResendView(AuthView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        user = request.user
        if not user.is_email_verified:
            if not claim_email_slot(user.email, "verify"):
                raise Throttled(
                    wait=settings.AUTH_EMAIL_COOLDOWN_SECONDS, detail="A verification email was just sent."
                )
            send_verification_email(user)
        return Response(status=status.HTTP_204_NO_CONTENT)


@extend_schema(request=GoogleLoginSerializer, responses={200: GoogleResultSerializer}, tags=TAGS)
class GoogleLoginView(AuthView):
    serializer_class = GoogleLoginSerializer

    def post(self, request):
        if not settings.GOOGLE_CLIENT_ID:
            raise ApiError("google_not_configured", "Google sign-in is not configured on this server.")
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            identity = verify_google_credential(serializer.validated_data["credential"])
        except GoogleSignInError as exc:
            raise ApiError("invalid_google_token", str(exc)) from exc
        user, created = sign_in_with_google(identity)
        login(request, user)
        return Response({"user": UserSerializer(user).data, "created": created})
