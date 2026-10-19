import mimetypes

from django.apps import AppConfig

#: What the development server and the admin send for stored audio, whatever the platform's own table says.
AUDIO_TYPES = {
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".weba": "audio/webm",
}


class AssetsConfig(AppConfig):
    name = "apps.assets"
    label = "assets"

    def ready(self) -> None:
        from . import signals  # noqa: F401

        for extension, mime in AUDIO_TYPES.items():
            mimetypes.add_type(mime, extension)
