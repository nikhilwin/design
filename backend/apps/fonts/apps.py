from django.apps import AppConfig


class FontsConfig(AppConfig):
    name = "apps.fonts"
    label = "fonts"

    def ready(self) -> None:
        from . import signals  # noqa: F401
