"""URLconf used only by the error-envelope tests: views that raise each kind of error on demand."""

from django.core.exceptions import PermissionDenied as DjangoPermissionDenied
from django.core.exceptions import ValidationError as DjangoValidationError
from django.http import Http404
from django.urls import include, path
from rest_framework import exceptions, serializers
from rest_framework.generics import GenericAPIView
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response

from apps.core.csrf import CsrfProtectedMixin
from apps.core.exceptions import ApiError


class Nested(serializers.Serializer):
    name = serializers.CharField(max_length=3)
    tags = serializers.ListField(child=serializers.IntegerField(), max_length=2)


class Payload(serializers.Serializer):
    email = serializers.EmailField()
    nested = Nested(required=False)


class Boom(GenericAPIView):
    permission_classes = [AllowAny]
    serializer_class = Payload

    def post(self, request, kind: str):
        if kind == "http404":
            raise Http404("secret detail")
        if kind == "django-denied":
            raise DjangoPermissionDenied("secret detail")
        if kind == "django-validation":
            raise DjangoValidationError({"title": ["Too long."]})
        if kind == "validation-string":
            raise exceptions.ValidationError("Just one message.")
        if kind == "validation-list":
            raise exceptions.ValidationError(["a", "b"])
        if kind == "throttled":
            raise exceptions.Throttled(wait=12.2)
        if kind == "throttled-unknown":
            raise exceptions.Throttled()
        if kind == "api-error":
            raise ApiError("custom_code", "Custom message.", status_code=409)
        if kind == "unauthenticated":
            raise exceptions.NotAuthenticated()
        if kind == "denied":
            raise exceptions.PermissionDenied()
        if kind == "boom":
            raise RuntimeError("unexpected")
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        return Response({"ok": True})


class Protected(GenericAPIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response({"ok": True})

    def post(self, request):
        return Response({"ok": True})


class GuardedForm(CsrfProtectedMixin, GenericAPIView):
    permission_classes = [AllowAny]

    def get(self, request):
        return Response({"ok": True})

    def post(self, request):
        return Response({"ok": True})


urlpatterns = [
    path("api/v1/", include("apps.core.urls")),
    path("api/v1/", include("apps.accounts.urls")),
    path("api/v1/boom/<str:kind>/", Boom.as_view()),
    path("api/v1/protected/", Protected.as_view()),
    path("api/v1/guarded/", GuardedForm.as_view()),
]

handler404 = "apps.core.views.not_found"
handler500 = "apps.core.views.server_failure"
