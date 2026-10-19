from django.urls import path

from . import views

urlpatterns = [
    path("size-presets/", views.size_presets, name="size-presets"),
]
