from apps.assets.throttling import _UserScopedThrottle


class AIRateThrottle(_UserScopedThrottle):
    """Per-user limit for calls to AI providers (`ai` rate), shared by the REST API and MCP."""

    scope = "ai"
