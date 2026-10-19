from django.urls import path

from . import views

urlpatterns = [
    path(
        "designs/<uuid:design_id>/share-links/",
        views.ShareLinkListCreateView.as_view(),
        name="share-link-list",
    ),
    path(
        "designs/<uuid:design_id>/share-links/<uuid:pk>/",
        views.ShareLinkDetailView.as_view(),
        name="share-link-detail",
    ),
    path(
        "designs/<uuid:design_id>/comments/",
        views.DesignCommentListCreateView.as_view(),
        name="design-comment-list",
    ),
    path(
        "designs/<uuid:design_id>/comments/<uuid:pk>/",
        views.DesignCommentDetailView.as_view(),
        name="design-comment-detail",
    ),
    path("shared/<str:token>/", views.SharedDesignView.as_view(), name="shared-design"),
    path(
        "shared/<str:token>/comments/",
        views.SharedCommentListCreateView.as_view(),
        name="shared-comment-list",
    ),
    path(
        "shared/<str:token>/comments/<uuid:pk>/",
        views.SharedCommentDetailView.as_view(),
        name="shared-comment-detail",
    ),
]
