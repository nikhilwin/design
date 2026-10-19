from django.urls import path

from . import views

urlpatterns = [
    path("models/", views.ModelListView.as_view(), name="ai-models"),
    path("contract.yaml", views.ContractView.as_view(), name="ai-contract"),
    path("providers/", views.ProviderListView.as_view(), name="ai-providers"),
    path("providers/<uuid:pk>/", views.ProviderDetailView.as_view(), name="ai-provider"),
    path("providers/<uuid:pk>/models/", views.ProviderModelsView.as_view(), name="ai-provider-models"),
    path("providers/<uuid:pk>/load-models/", views.ProviderLoadModelsView.as_view(), name="ai-provider-load"),
    path("providers/<uuid:pk>/test/", views.ProviderTestView.as_view(), name="ai-provider-test"),
    # Last: every task has the same endpoint.
    path("<slug:task>/", views.TaskView.as_view(), name="ai-task"),
]
