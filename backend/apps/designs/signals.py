from django.db.models.signals import pre_delete
from django.dispatch import receiver

from apps.assets.storage import delete_files_on_commit

from .models import Design, DesignVersion


@receiver(pre_delete, sender=Design, dispatch_uid="designs.design_delete_files")
def delete_design_files(sender, instance: Design, **kwargs) -> None:
    """Queue removal of the design's thumbnail and its versions' thumbnails (the rows cascade away)."""
    version_thumbnails = (
        DesignVersion.objects.filter(design_id=instance.pk)
        .exclude(thumbnail="")
        .values_list("thumbnail", flat=True)
    )
    delete_files_on_commit(instance.thumbnail.storage, [instance.thumbnail.name, *version_thumbnails])
