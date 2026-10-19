from django.apps import AppConfig


class DesignsConfig(AppConfig):
    name = "apps.designs"
    label = "designs"

    def ready(self) -> None:
        from . import signals  # noqa: F401
