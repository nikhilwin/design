from django.urls import path

from . import views

urlpatterns = [
    path("template-categories/", views.TemplateCategoryListView.as_view(), name="template-category-list"),
    path("templates/", views.TemplateListView.as_view(), name="template-list"),
    path("templates/<slug:slug>/", views.TemplateDetailView.as_view(), name="template-detail"),
    path("templates/<slug:slug>/use/", views.TemplateUseView.as_view(), name="template-use"),
]
