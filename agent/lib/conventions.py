# -*- coding: utf-8 -*-
"""Dynamic Research conventions — Python wrapper.

Canonical data lives in agent/lib/conventions.json. This module loads it
at runtime and exposes idiomatic Python helpers. Don't duplicate values
here — change conventions.json, the wrapper picks up.

Usage:
    import sys
    sys.path.insert(0, r"<path-to-agent>/lib")
    import conventions
    print(conventions.slugify("The Quickbase Modernization Dilemma"))
    print(conventions.studio_filename("Foo Bar", "20260507-125556", "video"))
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Optional

# ── Load canonical data ───────────────────────────────────────────────

_CONVENTIONS_PATH = Path(__file__).parent / "conventions.json"

with open(_CONVENTIONS_PATH, "r", encoding="utf-8") as _f:
    _data = json.load(_f)

# ── Public constants ──────────────────────────────────────────────────

VERSION: int = _data["_version"]
LAST_UPDATED: str = _data["_last_updated"]
BUCKET: str = _data["supabase_storage"]["bucket"]

SKIP_FILES: set[str] = set(_data["skip_files"]["exact"])
SKIP_PREFIXES: list[str] = list(_data["skip_files"]["prefixes"])
SKIP_EXTENSIONS: list[str] = list(_data["skip_files"].get("extensions", []))

RESEARCH_ROLES: set[str] = set(_data["filename_patterns"]["research"]["roles"])
RESEARCH_DOCX_ROLES: set[str] = set(_data["filename_patterns"]["research_docx_companion"]["roles"])
STUDIO_PRODUCTS: dict = _data["filename_patterns"]["studio"]["products"]

_STUDIO_REGEX = re.compile(_data["filename_patterns"]["studio"]["regex"])
_RESEARCH_REGEX = re.compile(_data["filename_patterns"]["research"]["regex"])
_RESEARCH_DOCX_REGEX = re.compile(_data["filename_patterns"]["research_docx_companion"]["regex"])

_SLUG_STRIP = re.compile(_data["slugify"]["strip_pattern_python"])
_SLUG_MAX = int(_data["slugify"]["max_length"])
_SLUG_FALLBACK = _data["slugify"]["fallback"]


# ── Public API ────────────────────────────────────────────────────────


def slugify(title: Optional[str]) -> str:
    """Canyon Lake S12 slugify: strip special, spaces->hyphens, lowercase, max length."""
    if not title:
        return _SLUG_FALLBACK
    s = _SLUG_STRIP.sub("", str(title))
    s = re.sub(r"\s+", "-", s.strip())
    s = re.sub(r"-+", "-", s).lower()
    s = s[:_SLUG_MAX].rstrip("-")
    return s or _SLUG_FALLBACK


def studio_filename(title: str, timestamp: str, product: str) -> str:
    """Build a Studio product filename: {title-slug}-{TIMESTAMP}-{product}.{ext}"""
    if product not in STUDIO_PRODUCTS:
        raise ValueError(f"unknown studio product: {product}")
    ext = STUDIO_PRODUCTS[product]["ext"]
    return f"{slugify(title)}-{timestamp}-{product}.{ext}"


def research_filename(topic_prefix: str, role: str, ext: str) -> str:
    """Build a research file filename: {topic-prefix}-{role}.{ext}"""
    if role not in RESEARCH_ROLES and role not in RESEARCH_DOCX_ROLES:
        raise ValueError(f"unknown research role: {role}")
    return f"{slugify(topic_prefix)}-{role}.{ext}"


def is_skip_file(filename: str) -> bool:
    """True if a filename should be skipped from any uploads/listings."""
    if filename in SKIP_FILES:
        return True
    for p in SKIP_PREFIXES:
        if filename.startswith(p):
            return True
    for ext in SKIP_EXTENSIONS:
        if filename.endswith(ext):
            return True
    return False


def classify_file(filename: str) -> str:
    """Classify a filename into one of: studio | research | research-docx | skip | unknown."""
    if is_skip_file(filename):
        return "skip"
    if _STUDIO_REGEX.match(filename):
        return "studio"
    if _RESEARCH_REGEX.match(filename):
        return "research"
    if _RESEARCH_DOCX_REGEX.match(filename):
        return "research-docx"
    return "unknown"


def parse_studio_filename(filename: str) -> Optional[dict]:
    """Parse a Studio filename, or None if not Studio-shaped."""
    m = _STUDIO_REGEX.match(filename)
    if not m:
        return None
    return {"title_slug": m.group(1), "timestamp": m.group(2), "product": m.group(3), "ext": m.group(4)}


def parse_research_filename(filename: str) -> Optional[dict]:
    """Parse a research filename, or None if not research-shaped."""
    m = _RESEARCH_REGEX.match(filename)
    if not m:
        return None
    return {"topic_prefix": m.group(1), "role": m.group(2), "ext": m.group(3)}


# ── Self-test when run directly ───────────────────────────────────────

if __name__ == "__main__":
    print(f"Conventions v{VERSION} ({LAST_UPDATED})")
    print(f"BUCKET: {BUCKET}")
    print(f"slugify('The Quickbase Modernization Dilemma: Domain Specificity vs. Infrastructure Security'):")
    print(f"  -> {slugify('The Quickbase Modernization Dilemma: Domain Specificity vs. Infrastructure Security')}")
    print(f"studio_filename('Foo Bar Baz', '20260507-125556', 'video'):")
    print(f"  -> {studio_filename('Foo Bar Baz', '20260507-125556', 'video')}")
    print(f"research_filename('cam-ai-quickbase-platform', 'brief', 'md'):")
    print(f"  -> {research_filename('cam-ai-quickbase-platform', 'brief', 'md')}")
    print(f"is_skip_file('job-manifest.json'): {is_skip_file('job-manifest.json')}")
    print(f"is_skip_file('helper.py'): {is_skip_file('helper.py')}")
    print(f"is_skip_file('nlm-discovered.json'): {is_skip_file('nlm-discovered.json')}")
    print(f"classify_file('the-foo-20260507-125556-video.mp4'): {classify_file('the-foo-20260507-125556-video.mp4')}")
    print(f"classify_file('cam-ai-brief.md'): {classify_file('cam-ai-brief.md')}")
    print(f"classify_file('cam-ai-context.md'): {classify_file('cam-ai-context.md')}")
    print(f"classify_file('random.txt'): {classify_file('random.txt')}")
