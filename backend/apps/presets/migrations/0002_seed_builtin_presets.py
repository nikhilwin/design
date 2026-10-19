# Adds the built-in size presets (backend/data/size_presets.json), so a new or upgraded site offers the
# same sizes the web app used to hard-code. `manage.py seed_size_presets` adds them again later.

from django.db import migrations


def seed(apps, schema_editor):
    from apps.presets.importer import builtin_catalogue, write

    write(
        builtin_catalogue(),
        group_model=apps.get_model("presets", "SizePresetGroup"),
        preset_model=apps.get_model("presets", "SizePreset"),
        overwrite=False,
    )


class Migration(migrations.Migration):

    dependencies = [
        ("presets", "0001_initial"),
    ]

    operations = [
        migrations.RunPython(seed, migrations.RunPython.noop),
    ]
