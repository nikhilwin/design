from django.core.management.base import BaseCommand, CommandError

from apps.designs.services import purge_expired_trash

DEFAULT_DAYS = 30


class Command(BaseCommand):
    help = "Permanently delete designs that have been in the trash for more than --days days."

    def add_arguments(self, parser):
        parser.add_argument("--days", type=int, default=DEFAULT_DAYS, help="Trash retention (default: 30).")

    def handle(self, *args, **options):
        days = options["days"]
        if days < 0:
            raise CommandError("--days must be zero or greater.")
        deleted = purge_expired_trash(days)
        self.stdout.write(f"Purged {deleted} design(s) trashed more than {days} day(s) ago.")
