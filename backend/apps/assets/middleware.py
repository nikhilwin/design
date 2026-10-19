from django.conf import settings

MEDIA_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'"


class MediaSecurityHeadersMiddleware:
    """Hardens user-uploaded files when Django itself serves `MEDIA_URL` (development).

    SVG is the dangerous one: even sanitised, it must never run script if opened directly, so media
    responses get a sandboxing CSP and `nosniff`, and SVG is forced to download when navigated to.
    Production reverse proxies must send the same headers for the media location.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        if request.path.startswith(settings.MEDIA_URL):
            response["X-Content-Type-Options"] = "nosniff"
            response["Content-Security-Policy"] = MEDIA_CSP
            if str(response.get("Content-Type", "")).startswith("image/svg"):
                response["Content-Disposition"] = "attachment"
        return response
