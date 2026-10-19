"""`/auth/tokens/`: the signed-in user's personal access tokens (for the MCP server).

Managing tokens needs the browser session: a token can never mint, list or revoke tokens itself.
"""

from __future__ import annotations

from django.shortcuts import get_object_or_404
from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.authentication import SessionAuthentication
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.views import confirm_identity
from apps.core.exceptions import ApiError
from apps.core.parsers import BoundedJSONParser
from apps.core.views import email_delivers

from . import services
from .scopes import SCOPES
from .serializers import ApiTokenCreateSerializer, ApiTokenSerializer, IssuedTokenSerializer, ScopeSerializer


class _SessionOnly:
    authentication_classes = [SessionAuthentication]
    parser_classes = [BoundedJSONParser]


@extend_schema(tags=["api-tokens"])
class ApiTokenListView(_SessionOnly, APIView):
    @extend_schema(responses=ApiTokenSerializer(many=True))
    def get(self, request):
        tokens = services.live_tokens(request.user)
        return Response(ApiTokenSerializer(tokens, many=True).data)

    @extend_schema(request=ApiTokenCreateSerializer, responses={201: IssuedTokenSerializer})
    def post(self, request):
        if email_delivers() and not request.user.is_email_verified:
            # An unverified address may belong to someone else, who could take the account over later.
            # (Where no email is sent nobody can verify; a Google takeover still drops the tokens.)
            raise ApiError(
                "email_not_verified",
                "Confirm your email address before creating a token.",
                status.HTTP_403_FORBIDDEN,
            )
        body = ApiTokenCreateSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        data = dict(body.validated_data)
        confirm_identity(request.user, {key: data.pop(key, "") for key in ("password", "confirm_email")})
        issued = services.issue_token(request.user, **data)
        data = {**ApiTokenSerializer(issued.token).data, "token": issued.plaintext}
        return Response(data, status=status.HTTP_201_CREATED)


@extend_schema(tags=["api-tokens"])
class ApiTokenDetailView(_SessionOnly, APIView):
    @extend_schema(responses={204: None})
    def delete(self, request, pk):
        token = get_object_or_404(services.live_tokens(request.user), pk=pk)
        services.revoke(token)
        return Response(status=status.HTTP_204_NO_CONTENT)


@extend_schema(tags=["api-tokens"])
class ApiTokenScopesView(_SessionOnly, APIView):
    @extend_schema(responses=ScopeSerializer(many=True))
    def get(self, request):
        return Response([{"id": key, "description": text} for key, text in SCOPES.items()])
