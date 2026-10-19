from django.db.models.signals import post_delete
from django.dispatch import receiver

from .models import FontVariant


@receiver(post_delete, sender=FontVariant)
def delete_variant_file(sender, instance: FontVariant, **kwargs) -> None:
    """Removing a variant (or its family) must remove the font file from storage too."""
    if instance.file:
        instance.file.storage.delete(instance.file.name)
