from django.apps import AppConfig


class CollabConfig(AppConfig):
    name = "apps.collab"
    label = "collab"

    def ready(self) -> None:
        from . import signals  # noqa: F401
