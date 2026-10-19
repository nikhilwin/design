from django.conf import settings
from rest_framework.permissions import SAFE_METHODS, BasePermission


class IsOwner(BasePermission):
    """Object-level: `obj.owner == request.user`."""

    def has_object_permission(self, request, view, obj):
        return getattr(obj, "owner_id", None) == request.user.id


class IsOwnerOrReadOnly(IsOwner):
    def has_object_permission(self, request, view, obj):
        return request.method in SAFE_METHODS or super().has_object_permission(request, view, obj)


class StaffOrDebug(BasePermission):
    """Staff accounts, or anybody while the development server runs with `DEBUG`."""

    def has_permission(self, request, view):
        return bool(
            settings.DEBUG or (request.user and request.user.is_authenticated and request.user.is_staff)
        )
