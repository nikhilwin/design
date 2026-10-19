from django.urls import path

from . import views

urlpatterns = [
    path("auth/tokens/", views.ApiTokenListView.as_view(), name="api-token-list"),
    path("auth/tokens/scopes/", views.ApiTokenScopesView.as_view(), name="api-token-scopes"),
    path("auth/tokens/<uuid:pk>/", views.ApiTokenDetailView.as_view(), name="api-token-detail"),
]
