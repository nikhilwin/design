"""What a personal access token may do. Every tool that accepts tokens names the scope it needs."""

from __future__ import annotations

DESIGNS_READ = "designs:read"
DESIGNS_WRITE = "designs:write"
ASSETS_WRITE = "assets:write"
COMMENTS_WRITE = "comments:write"
# Added after the first tokens were issued: new powers get new scopes, so an existing token never gains one
# without its owner choosing it.
DESIGNS_TRASH = "designs:trash"
COMMENTS_MANAGE = "comments:manage"
BRAND_WRITE = "brand:write"
SHARING_WRITE = "sharing:write"

SCOPES: dict[str, str] = {
    DESIGNS_READ: "See your designs, their versions and comments, and browse templates, elements and fonts.",
    DESIGNS_WRITE: "Create, edit, rename, duplicate and organise your designs, and restore earlier versions.",
    DESIGNS_TRASH: "Move your designs to the trash and restore them.",
    ASSETS_WRITE: "Add images to your uploads (stock photos, images from a URL, AI background removal).",
    COMMENTS_WRITE: "Add comments to your designs.",
    COMMENTS_MANAGE: "Edit your own comments, and resolve and delete comments on your designs (anyone's).",
    BRAND_WRITE: "Create and change your brand kits.",
    SHARING_WRITE: "See, create and revoke share links to your designs (they let other people in).",
}
DEFAULT_SCOPES = (DESIGNS_READ, DESIGNS_WRITE)
