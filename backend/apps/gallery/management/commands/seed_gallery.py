from django.core.management.base import BaseCommand
from django.db import transaction

from apps.gallery.models import TemplateCategory

# (slug, name, Lucide icon name). The order is the display order.
CATEGORIES = [
    ("social-media", "Social Media", "share-2"),
    ("presentations", "Presentations", "presentation"),
    ("posters", "Posters", "image"),
    ("flyers", "Flyers", "file-text"),
    ("invitations", "Invitations", "mail"),
    ("cards", "Cards", "credit-card"),
    ("resumes", "Resumes", "file-user"),
    ("logos", "Logos", "shapes"),
    ("marketing", "Marketing", "megaphone"),
    ("education", "Education", "graduation-cap"),
    ("business", "Business", "briefcase"),
    ("photo-collage", "Photo Collage", "layout-grid"),
    ("youtube", "YouTube", "circle-play"),
    ("print", "Print", "printer"),
]


class Command(BaseCommand):
    help = (
        "Create the standard template categories (idempotent). Existing categories keep their edited "
        "name, icon and order unless --update is given."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--update",
            action="store_true",
            help="Reset name, icon and sort order of existing standard categories to the defaults.",
        )

    @transaction.atomic
    def handle(self, *args, update: bool = False, **options):
        created = updated = unchanged = 0
        for order, (slug, name, icon) in enumerate(CATEGORIES, start=1):
            defaults = {"name": name, "icon": icon, "sort_order": order * 10}
            category, was_created = TemplateCategory.objects.get_or_create(slug=slug, defaults=defaults)
            if was_created:
                created += 1
            elif update and any(getattr(category, field) != value for field, value in defaults.items()):
                for field, value in defaults.items():
                    setattr(category, field, value)
                category.save()
                updated += 1
            else:
                unchanged += 1
        self.stdout.write(
            self.style.SUCCESS(
                f"Template categories: {created} created, {updated} updated, {unchanged} unchanged."
            )
        )
