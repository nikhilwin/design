from django.db.models.signals import post_delete
from django.dispatch import receiver

from .models import Element, ElementPack


@receiver(post_delete, sender=Element)
def delete_element_svg(sender, instance: Element, **kwargs) -> None:
    if instance.svg:
        instance.svg.storage.delete(instance.svg.name)


@receiver(post_delete, sender=ElementPack)
def delete_pack_thumbnail(sender, instance: ElementPack, **kwargs) -> None:
    if instance.thumbnail:
        instance.thumbnail.storage.delete(instance.thumbnail.name)
