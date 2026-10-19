from django.conf import settings
from django.db.models import Q
from django.shortcuts import get_object_or_404
from django.utils.cache import add_never_cache_headers, patch_vary_headers
from django_filters.rest_framework import DjangoFilterBackend
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import generics, status
from rest_framework.exceptions import NotFound, Throttled
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response

from apps.core.pagination import StandardPagination
from apps.designs.models import Design
from apps.designs.parsers import DesignJSONParser
from apps.fonts.usage import uploaded_fonts_used_by

from .exceptions import (
    CommentsDisabled,
    PasswordRequiredError,
    PayloadTooLarge,
    ShareRoleInsufficient,
    bad_request,
)
from .models import Comment, ShareLink, ShareRole
from .serializers import (
    CommentCreateSerializer,
    CommentMoveSerializer,
    CommentSerializer,
    CommentUpdateSerializer,
    SharedDesignSerializer,
    SharedSaveResultSerializer,
    SharedSaveSerializer,
    ShareLinkCreateSerializer,
    ShareLinkSerializer,
    ShareLinkUpdateSerializer,
)
from .services import (
    MAX_COMMENTS_PER_DESIGN,
    DesignUnavailable,
    PasswordLocked,
    PasswordRequired,
    RevisionConflict,
    ShareLinkNotFound,
    create_link,
    enforce_link_password,
    record_access,
    resolve_link,
    save_shared_document,
    update_link,
)
from .throttling import UploadScopeThrottleMixin, client_ip

GATE_HEADER = "X-Share-Password"
COMMENT_ROLES = (ShareRole.COMMENT, ShareRole.EDIT)
PASSWORD_PARAMETER = OpenApiParameter(
    GATE_HEADER, OpenApiTypes.STR, OpenApiParameter.HEADER, required=False,
    description="Password of the link, when it has one.",
)  # fmt: skip


class CommentPagination(StandardPagination):
    page_size = 100


# ---------------------------------------------------------------------------------------------
# Owner endpoints
# ---------------------------------------------------------------------------------------------


class OwnerAPIView(generics.GenericAPIView):
    """Base for `/designs/{design_id}/...` endpoints: only the owner can see the design (404 otherwise)."""

    parser_classes = [DesignJSONParser]
    filter_backends: list = []

    def get_design(self) -> Design:
        designs = Design.objects.filter(owner=self.request.user).defer("document")
        return get_object_or_404(designs, pk=self.kwargs["design_id"])


class ShareLinkListCreateView(OwnerAPIView):
    serializer_class = ShareLinkSerializer

    @extend_schema(responses=ShareLinkSerializer(many=True), tags=["sharing"])
    def get(self, request, design_id):
        design = self.get_design()
        page = self.paginate_queryset(ShareLink.objects.filter(design=design))
        return self.get_paginated_response(ShareLinkSerializer(page, many=True).data)

    @extend_schema(request=ShareLinkCreateSerializer, responses={201: ShareLinkSerializer}, tags=["sharing"])
    def post(self, request, design_id):
        design = self.get_design()
        if design.trashed_at is not None:
            raise bad_request("design_trashed", "Restore the design before sharing it.")
        serializer = ShareLinkCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        link = create_link(design, serializer, request.user)
        return Response(ShareLinkSerializer(link).data, status=status.HTTP_201_CREATED)


class ShareLinkDetailView(OwnerAPIView):
    serializer_class = ShareLinkSerializer

    def get_link(self) -> ShareLink:
        design = self.get_design()
        return get_object_or_404(ShareLink.objects.filter(design=design), pk=self.kwargs["pk"])

    @extend_schema(responses=ShareLinkSerializer, tags=["sharing"])
    def get(self, request, design_id, pk):
        return Response(ShareLinkSerializer(self.get_link()).data)

    @extend_schema(request=ShareLinkUpdateSerializer, responses=ShareLinkSerializer, tags=["sharing"])
    def patch(self, request, design_id, pk):
        link = self.get_link()
        serializer = ShareLinkUpdateSerializer(link, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        return Response(ShareLinkSerializer(update_link(link, serializer)).data)

    @extend_schema(responses={204: None}, tags=["sharing"])
    def delete(self, request, design_id, pk):
        """Revoke: the link stops working immediately and disappears from the list."""
        self.get_link().delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class DesignCommentListCreateView(UploadScopeThrottleMixin, OwnerAPIView):
    serializer_class = CommentSerializer
    pagination_class = CommentPagination
    filter_backends = [DjangoFilterBackend]
    filterset_fields = ["resolved", "page_id"]

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return Comment.objects.none()
        return Comment.objects.filter(design_id=self.kwargs["design_id"]).select_related("author")

    @extend_schema(responses=CommentSerializer(many=True), tags=["comments"])
    def get(self, request, design_id):
        self.get_design()
        page = self.paginate_queryset(self.filter_queryset(self.get_queryset()))
        return self.get_paginated_response(CommentSerializer(page, many=True).data)

    @extend_schema(request=CommentCreateSerializer, responses={201: CommentSerializer}, tags=["comments"])
    def post(self, request, design_id):
        design = self.get_design()
        if design.trashed_at is not None:
            raise bad_request("design_trashed", "Restore the design before commenting on it.")
        comment = create_comment(request, design.pk)
        return Response(CommentSerializer(comment).data, status=status.HTTP_201_CREATED)


class DesignCommentDetailView(OwnerAPIView):
    serializer_class = CommentSerializer

    @extend_schema(request=CommentUpdateSerializer, responses=CommentSerializer, tags=["comments"])
    def patch(self, request, design_id, pk):
        """Owner only: mark a thread as resolved / re-open it, move its pin, or edit one's own comment."""
        comment = get_object_or_404(
            Comment.objects.filter(design_id=design_id, design__owner=request.user).select_related("author"),
            pk=pk,
        )
        serializer = CommentUpdateSerializer(comment, data=request.data, context={"user": request.user})
        serializer.is_valid(raise_exception=True)
        comment = serializer.save()
        return Response(CommentSerializer(comment).data)

    @extend_schema(responses={204: None}, tags=["comments"])
    def delete(self, request, design_id, pk):
        """The design owner can delete any comment; everybody else only their own."""
        comments = Comment.objects.filter(design_id=design_id).filter(
            Q(design__owner=request.user) | Q(author=request.user)
        )
        get_object_or_404(comments, pk=pk).delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


def create_comment(request, design_id) -> Comment:
    """Shared by the owner and the share-link comment endpoints."""
    serializer = CommentCreateSerializer(data=request.data, context={"design_id": design_id})
    serializer.is_valid(raise_exception=True)
    if Comment.objects.filter(design_id=design_id).count() >= MAX_COMMENTS_PER_DESIGN:
        raise bad_request("comment_limit_reached", "This design has reached its comment limit.")
    return serializer.save(design_id=design_id, author=request.user)


# ---------------------------------------------------------------------------------------------
# Public (token) endpoints
# ---------------------------------------------------------------------------------------------


class SharedAPIView(generics.GenericAPIView):
    """Base for `/shared/{token}/...`: link lookup, password gate and no-store headers."""

    parser_classes = [DesignJSONParser]
    filter_backends: list = []
    public_methods = frozenset({"GET"})

    def get_permissions(self):
        if self.request.method in self.public_methods:
            return [AllowAny()]
        return [IsAuthenticated()]

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        add_never_cache_headers(response)
        patch_vary_headers(response, ("Cookie", GATE_HEADER))
        return response

    def load_link(self, token: str, *, with_document: bool = False) -> ShareLink:
        """Valid link for the URL token with the password rule applied. 404 never says why."""
        try:
            link = resolve_link(token, with_document=with_document)
        except ShareLinkNotFound:
            raise NotFound()
        try:
            enforce_link_password(link, self.request.headers.get(GATE_HEADER), client_ip(self.request))
        except PasswordRequired:
            raise PasswordRequiredError()
        except PasswordLocked as exc:
            raise Throttled(wait=exc.retry_after)
        return link

    def load_comment_link(self, token: str) -> ShareLink:
        link = self.load_link(token)
        if link.role not in COMMENT_ROLES:
            raise CommentsDisabled()
        return link


class SharedDesignView(SharedAPIView):
    serializer_class = SharedDesignSerializer

    @extend_schema(parameters=[PASSWORD_PARAMETER], responses=SharedDesignSerializer, tags=["sharing"])
    def get(self, request, token):
        link = self.load_link(token, with_document=True)
        record_access(link)
        design = link.design
        payload = {
            "design_id": design.pk,
            "role": link.role,
            "title": design.title,
            "width": design.width,
            "height": design.height,
            "revision": design.revision,
            "owner": design.owner,
            "document": design.document,
            "fonts": uploaded_fonts_used_by(design.document, design.owner),
        }
        return Response(SharedDesignSerializer(payload).data)

    @extend_schema(
        parameters=[PASSWORD_PARAMETER],
        request=SharedSaveSerializer,
        responses={200: SharedSaveResultSerializer},
        tags=["sharing"],
    )
    def patch(self, request, token):
        """Save through an `edit` link (optimistic concurrency on `base_revision`)."""
        limit = settings.MAX_DESIGN_DOCUMENT_BYTES + 64 * 1024
        if int(request.META.get("CONTENT_LENGTH") or 0) > limit:
            raise PayloadTooLarge()
        link = self.load_link(token)
        if link.role != ShareRole.EDIT:
            raise ShareRoleInsufficient("This link is read-only.")
        serializer = SharedSaveSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            saved = save_shared_document(
                link.design,
                serializer.validated_data["document"],
                serializer.validated_data["base_revision"],
                request.user,
            )
        except RevisionConflict as conflict:
            return Response(
                {
                    "error": {
                        "code": "revision_conflict",
                        "message": "The design was changed by someone else.",
                    },
                    "current": {"revision": conflict.current_revision, "updated_at": conflict.updated_at},
                },
                status=status.HTTP_409_CONFLICT,
            )
        except DesignUnavailable:
            raise NotFound()
        return Response({"revision": saved.revision, "updated_at": saved.updated_at})


class SharedCommentListCreateView(UploadScopeThrottleMixin, SharedAPIView):
    serializer_class = CommentSerializer
    pagination_class = CommentPagination

    @extend_schema(parameters=[PASSWORD_PARAMETER], responses=CommentSerializer(many=True), tags=["comments"])
    def get(self, request, token):
        link = self.load_comment_link(token)
        comments = Comment.objects.filter(design_id=link.design_id).select_related("author")
        page = self.paginate_queryset(comments)
        return self.get_paginated_response(CommentSerializer(page, many=True).data)

    @extend_schema(
        parameters=[PASSWORD_PARAMETER],
        request=CommentCreateSerializer,
        responses={201: CommentSerializer},
        tags=["comments"],
    )
    def post(self, request, token):
        link = self.load_comment_link(token)
        comment = create_comment(request, link.design_id)
        return Response(CommentSerializer(comment).data, status=status.HTTP_201_CREATED)


class SharedCommentDetailView(SharedAPIView):
    serializer_class = CommentSerializer

    @extend_schema(
        parameters=[PASSWORD_PARAMETER],
        request=CommentMoveSerializer,
        responses=CommentSerializer,
        tags=["comments"],
    )
    def patch(self, request, token, pk):
        """Authors move the pin of their own thread through a `comment` or `edit` link."""
        link = self.load_comment_link(token)
        comment = get_object_or_404(
            Comment.objects.filter(design_id=link.design_id, author=request.user).select_related("author"),
            pk=pk,
        )
        serializer = CommentMoveSerializer(comment, data=request.data)
        serializer.is_valid(raise_exception=True)
        return Response(CommentSerializer(serializer.save()).data)

    @extend_schema(parameters=[PASSWORD_PARAMETER], responses={204: None}, tags=["comments"])
    def delete(self, request, token, pk):
        """Authors can remove their own comments through any valid link of the design."""
        link = self.load_link(token)
        comment = get_object_or_404(
            Comment.objects.filter(design_id=link.design_id, author=request.user), pk=pk
        )
        comment.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)
