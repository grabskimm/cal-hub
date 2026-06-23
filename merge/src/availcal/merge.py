"""Dedup + per-source overlap collapse.

Two-stage pipeline:
  1. **Dedup** the combined cloud+device intervals: first by ``(source, uid)``
     (the same event arriving via two feeds), then by fuzzy time match
     (identical start/end within +-1 minute) within a source.
  2. **Collapse overlaps per-source ONLY**: group by the single-word source
     label and merge overlapping/adjacent blocks within each group into maximal
     blocks. Blocks from different sources are NEVER merged — that would destroy
     the attribution the whole design exists to preserve. The result may contain
     time-overlapping blocks, each retaining its own one-word label.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import timedelta

from .models import BusyInterval

FUZZY_WINDOW = timedelta(minutes=1)

# Strength ordering: when collapsing a source's overlapping blocks, the merged
# block takes the strongest status present.
_STATUS_RANK = {"tentative": 0, "busy": 1, "oof": 2}


def _strongest(statuses: list[str]) -> str:
    return max(statuses, key=lambda s: _STATUS_RANK.get(s, 1))


def _dedup(intervals: list[BusyInterval]) -> list[BusyInterval]:
    """Drop exact UID duplicates and fuzzy time-duplicates within a source."""
    by_uid: dict[tuple[str, str], BusyInterval] = {}
    no_uid: list[BusyInterval] = []
    for iv in intervals:
        if iv.uid:
            key = (iv.source, iv.uid)
            # First writer wins; identical event via a second feed is dropped.
            by_uid.setdefault(key, iv)
        else:
            no_uid.append(iv)

    kept: list[BusyInterval] = []
    # Fuzzy dedup is only meaningful within a source, so index kept intervals by
    # source and scan only that source's list (not every kept interval).
    kept_by_source: dict[str, list[BusyInterval]] = defaultdict(list)
    seen: set[BusyInterval] = set()

    def add(iv: BusyInterval) -> None:
        kept.append(iv)
        kept_by_source[iv.source].append(iv)
        seen.add(iv)

    # Fuzzy pass: an interval matching an already-kept one in the SAME source
    # (start and end within +-1 min) is a duplicate even with a different/absent
    # UID.
    def is_fuzzy_dup(iv: BusyInterval) -> bool:
        return any(
            abs(k.start - iv.start) <= FUZZY_WINDOW
            and abs(k.end - iv.end) <= FUZZY_WINDOW
            for k in kept_by_source[iv.source]
        )

    for iv in by_uid.values():
        add(iv)

    for iv in no_uid + [iv for iv in intervals if iv.uid]:
        # Skip exact duplicates (O(1) via the set) and same-source fuzzy dups.
        if iv in seen or is_fuzzy_dup(iv):
            continue
        add(iv)
    return kept


def _collapse_one_source(intervals: list[BusyInterval]) -> list[BusyInterval]:
    """Collapse overlapping/adjacent blocks within a single source."""
    if not intervals:
        return []
    ordered = sorted(intervals, key=lambda i: (i.start, i.end))
    source = ordered[0].source
    out: list[BusyInterval] = []

    cur_start = ordered[0].start
    cur_end = ordered[0].end
    cur_statuses = [ordered[0].status]

    for iv in ordered[1:]:
        if iv.start <= cur_end:  # overlap or adjacency
            cur_end = max(cur_end, iv.end)
            cur_statuses.append(iv.status)
        else:
            out.append(
                BusyInterval(cur_start, cur_end, source, _strongest(cur_statuses))
            )
            cur_start, cur_end, cur_statuses = iv.start, iv.end, [iv.status]
    out.append(BusyInterval(cur_start, cur_end, source, _strongest(cur_statuses)))
    return out


PUBLIC_LABEL = "Busy"


def flatten_across_sources(
    intervals: list[BusyInterval], *, label: str = PUBLIC_LABEL
) -> list[BusyInterval]:
    """Union ALL busy intervals across every source into non-overlapping blocks.

    This is the opposite of the per-source merge: it deliberately ERASES source
    boundaries. The output reveals only occupied time windows — never how many
    calendars exist, their labels, or which one is busy — which is exactly what a
    fully-anonymized *public* free/busy feed must expose. Overlapping blocks from
    different sources collapse into one, so the source count cannot be inferred.
    """
    if not intervals:
        return []
    # Relabel everything to a single sentinel, then collapse as one source.
    relabeled = [BusyInterval(iv.start, iv.end, label, "busy") for iv in intervals]
    return _collapse_one_source(relabeled)


def merge_intervals(intervals: list[BusyInterval]) -> list[BusyInterval]:
    """Full merge: dedup, then collapse overlaps per-source only."""
    deduped = _dedup(intervals)

    by_source: dict[str, list[BusyInterval]] = defaultdict(list)
    for iv in deduped:
        by_source[iv.source].append(iv)

    merged: list[BusyInterval] = []
    for source_intervals in by_source.values():
        merged.extend(_collapse_one_source(source_intervals))
    return merged
