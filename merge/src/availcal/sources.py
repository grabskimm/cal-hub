"""Source registry: the one place that maps every raw input to its label.

A single ``sources.toml`` maps each raw input — an ICS feed key, a CalDAV
account/collection, or a device store/calendar name — to exactly one
single-word label. Both the merge job and the local agents read it. Labels are
validated at load time as **unique single tokens**; whitespace or duplicates
fail fast.
"""

from __future__ import annotations

import re
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

from .models import SOURCE_LABEL_RE

# Sections recognised in sources.toml. Each maps rawname -> label.
_SECTIONS = ("ics", "caldav", "device")


def slugify_label(raw: str) -> str:
    """Reduce an arbitrary raw store name to a single ``^\\w+$`` token.

    Used for unmapped sources: we never drop data, we slugify and log that an
    explicit registry entry is needed.
    """
    # Keep word chars; collapse the rest. Title-case-ish first token.
    cleaned = re.sub(r"\W+", "_", raw.strip()).strip("_")
    if not cleaned:
        cleaned = "Unknown"
    return cleaned


@dataclass
class SourceRegistry:
    """Resolved rawname -> label maps, grouped by section."""

    ics: dict[str, str] = field(default_factory=dict)
    caldav: dict[str, str] = field(default_factory=dict)
    device: dict[str, str] = field(default_factory=dict)
    _unmapped_logged: set[str] = field(default_factory=set)

    @property
    def all_labels(self) -> set[str]:
        labels: set[str] = set()
        for section in _SECTIONS:
            labels.update(getattr(self, section).values())
        return labels

    def resolve(self, section: str, rawname: str) -> str:
        """Return the label for *rawname* in *section*.

        An unmapped source is slugified to one word; the first time we see it we
        record it so the caller can log "needs a sources.toml entry".
        """
        mapping: dict[str, str] = getattr(self, section)
        if rawname in mapping:
            return mapping[rawname]
        slug = slugify_label(rawname)
        self._unmapped_logged.add(f"[{section}] {rawname!r} -> {slug!r}")
        return slug

    def unmapped(self) -> list[str]:
        return sorted(self._unmapped_logged)


def _validate_labels(maps: dict[str, dict[str, str]]) -> None:
    """Fail fast on whitespace labels or labels reused across raw inputs."""
    seen: dict[str, str] = {}
    for section, mapping in maps.items():
        for rawname, label in mapping.items():
            if not isinstance(label, str) or not SOURCE_LABEL_RE.match(label):
                raise ValueError(
                    f"source label {label!r} for [{section}] {rawname!r} must be "
                    f"a single token matching ^\\w+$ (no spaces)"
                )
            if label in seen and seen[label] != f"{section}:{rawname}":
                raise ValueError(
                    f"duplicate source label {label!r} used by "
                    f"{seen[label]} and {section}:{rawname}; labels must be unique"
                )
            seen[label] = f"{section}:{rawname}"


def load_sources(path: str | Path) -> SourceRegistry:
    """Load and validate ``sources.toml``."""
    data = tomllib.loads(Path(path).read_text())
    maps = {section: dict(data.get(section, {})) for section in _SECTIONS}
    _validate_labels(maps)
    return SourceRegistry(ics=maps["ics"], caldav=maps["caldav"], device=maps["device"])
