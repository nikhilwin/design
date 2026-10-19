from django.apps import AppConfig


class GalleryConfig(AppConfig):
    name = "apps.gallery"
    label = "gallery"

    def ready(self) -> None:
        from . import signals  # noqa: F401
