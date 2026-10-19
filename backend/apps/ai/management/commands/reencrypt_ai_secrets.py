"""Re-encrypt provider secrets with the current primary key.

Decrypts all secrets stored in the database using the configured key and fallbacks,
and writes them back encrypted with the primary key. This allows retiring old fallback keys.
"""

from django.core.management.base import BaseCommand, CommandError

from apps.ai import secrets
from apps.ai.models import Provider


class Command(BaseCommand):
    help = "Re-encrypt stored AI provider secrets with the current primary key."

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Show how many secrets would be re-encrypted without saving changes.",
        )

    def handle(self, *args, **options):
        dry_run = options["dry_run"]
        providers = Provider.objects.exclude(secret_encrypted=b"")
        reencrypted = 0
        failed = 0

        for provider in providers:
            try:
                decrypted = secrets.decrypt(bytes(provider.secret_encrypted))
            except secrets.SecretUnreadable:
                self.stderr.write(
                    f"Provider {provider.pk} ({provider.name}): "
                    "could not decrypt secret with any configured key."
                )
                failed += 1
                continue

            new_encrypted = secrets.encrypt(decrypted)
            if not dry_run:
                provider.secret_encrypted = new_encrypted
                provider.save(update_fields=["secret_encrypted"])
            reencrypted += 1

        action_word = "Would re-encrypt" if dry_run else "Re-encrypted"
        self.stdout.write(
            self.style.SUCCESS(f"{action_word} {reencrypted} provider secret(s). {failed} failed.")
        )
        if failed:
            raise CommandError(f"{failed} provider secret(s) could not be decrypted; enter them again.")
