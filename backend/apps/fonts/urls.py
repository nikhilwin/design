from django.urls import path

from . import views

urlpatterns = [
    path("fonts/", views.PublicFontList.as_view(), name="font-list"),
    path("fonts/mine/", views.UserFontListCreate.as_view(), name="font-mine"),
    path("fonts/mine/<uuid:pk>/", views.UserFontDelete.as_view(), name="font-mine-detail"),
]
