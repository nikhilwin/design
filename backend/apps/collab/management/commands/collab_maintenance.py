"""Housekeeping for real-time rooms; safe to run at any time (start-up, cron)."""

from __future__ import annotations

from django.conf import settings
from django.core.management.base import BaseCommand

from apps.collab import crdt, engine, store


class Command(BaseCommand):
    help = (
        "Save designs whose real-time state is ahead of their document (after a crash), fold long update "
        "logs into their snapshot and remove presence rows of processes that are gone."
    )

    def handle(self, *args, **options) -> None:
        removed = store.purge_stale_presence()
        saved = skipped = failed = 0
        for design_id in store.unflushed_designs():
            if store.room_is_live(design_id):
                skipped += 1
                continue
            outcome = self.save(design_id)
            saved += outcome == "saved"
            skipped += outcome == "skipped"
            failed += outcome == "failed"
        compacted = 0
        for design_id in store.designs_needing_compaction(settings.REALTIME_COMPACT_AFTER_UPDATES):
            if store.room_is_live(design_id):
                continue
            source = store.read_for_compaction(design_id)
            if source is None:
                continue
            merge = crdt.executor(crdt.READ).submit(engine.merge_state, source.snapshot, source.updates)
            merged = merge.result()
            compacted += store.apply_compaction(design_id, source, merged)
        self.stdout.write(
            f"saved {saved}, skipped {skipped}, failed {failed}; compacted {compacted}; "
            f"removed {removed} stale connection rows"
        )

    def save(self, design_id) -> str:
        current = store.load_current(design_id)
        version = store.current_version(design_id)
        if current is None or version is None:
            return "skipped"
        pool = crdt.executor(crdt.READ)
        state = pool.submit(engine.merge_state, *current).result()
        conversion = pool.submit(engine.convert, state).result()
        if conversion.document is None:
            self.stderr.write(f"design {design_id}: not saved ({conversion.problem})")
            return "failed"
        result = store.flush_document(design_id, conversion.document, version, None)
        return "saved" if result.saved else "skipped"
