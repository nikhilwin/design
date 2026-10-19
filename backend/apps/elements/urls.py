from django.urls import path

from . import views

urlpatterns = [
    path("elements/packs/", views.ElementPackListView.as_view(), name="element-pack-list"),
    path("elements/", views.ElementListView.as_view(), name="element-list"),
]
