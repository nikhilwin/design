from django.db.models.signals import post_delete
from django.dispatch import receiver

from .models import Template


@receiver(post_delete, sender=Template)
def delete_template_thumbnail(sender, instance: Template, **kwargs) -> None:
    """Deleting a template (admin, cascade, shell) must not leave its thumbnail in storage."""
    if instance.thumbnail:
        instance.thumbnail.storage.delete(instance.thumbnail.name)
