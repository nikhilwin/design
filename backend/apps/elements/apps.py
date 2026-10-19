from django.apps import AppConfig


class ElementsConfig(AppConfig):
    name = "apps.elements"
    label = "elements"

    def ready(self) -> None:
        from . import signals  # noqa: F401
