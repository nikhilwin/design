from django.core.management.base import BaseCommand, CommandError

from apps.elements.seed import BUILTIN_PACKS, seed_builtin_packs, seed_graphics_packs


class Command(BaseCommand):
    help = (
        "Generate Doory's original CC0 artwork and import it: the shapes of backend/data/generate_shapes.py "
        "(packs " + ", ".join(name for _, name, _, _ in BUILTIN_PACKS) + ") and the graphics sets of "
        "backend/data/graphics/ (patterns, badges, dividers, speech bubbles, social glyphs, sale badges, "
        "charts, doodles). Idempotent; needs no network. Icon, emoji and illustration packs are installed "
        "by sync_element_packs."
    )

    def handle(self, *args, **options):
        summaries = seed_builtin_packs()
        names = {slug: name for slug, name, _, _ in BUILTIN_PACKS}
        for slug, summary in summaries.items():
            self.stdout.write(f"{names[slug]}: {summary}")
            for label, reason in summary.skipped:
                self.stderr.write(self.style.WARNING(f"  skipped {label}: {reason}"))
        total = sum(s.created + s.updated + s.unchanged for s in summaries.values())
        self.stdout.write(f"Shapes: {total} elements in {len(summaries)} packs.")

        report = seed_graphics_packs(log=self.stdout.write)
        if report.failed:
            raise CommandError(f"{len(report.failed)} graphics pack(s) failed: {report.failed[0].error}")
        graphics = sum(r.total for r in report.results)
        self.stdout.write(
            self.style.SUCCESS(
                f"Done: {total + graphics} elements in {len(summaries) + len(report.results)} packs."
            )
        )
