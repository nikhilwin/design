from django.urls import path

from . import views

urlpatterns = [path("collab/stats/", views.stats, name="collab-stats")]
