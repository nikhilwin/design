from django.apps import AppConfig


class AiConfig(AppConfig):
    name = "apps.ai"
    label = "ai"
    verbose_name = "AI providers"

    def ready(self) -> None:
        from . import checks  # noqa: F401
