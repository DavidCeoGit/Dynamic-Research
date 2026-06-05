# -*- coding: utf-8 -*-
"""Forensic cleanup tool for Supabase Storage gallery naming drift.

Apply S28 Canyon Lake naming conventions to a slug's storage folder:
  - Studio products: {title-slug}-{YYYYMMDD-HHMMSS}-{product}.{ext}
  - Research files: {topic-prefix}-{role}.{ext} (no timestamp)
  - Skip/noise files: deleted per conventions.skip_files

Use when a recovery script (finalize-recovered-run.ts pre-S30) uploaded
files with as-is timestamp naming, or when a slug otherwise diverged
from conventions. Idempotent — running twice on a clean slug is a no-op.

This is the productionized version of c:/tmp/gallery-cleanup.py (S29).
Conventions are imported from agent/lib/conventions.py — no duplicated
slugify/skip rules.

Usage:
  python agent/scripts/cleanup-supabase-naming.py --config <plan.json> [--dry-run]
  python agent/scripts/cleanup-supabase-naming.py --slug <slug> --topic-prefix <p> --iso-ts <T> --titles <json> [--dry-run]

Plan JSON format (a dict whose keys are slug strings):
  {
    "<slug-1>": {
      "topic_prefix": "cam-ai-quickbase-platform",
      "iso_ts_in_filenames": "2026-05-09T17-07-06",
      "research_ts_in_filenames": "20260508-194549",  // optional, defaults to iso_ts
      "studio_titles": {
        "audio": "...", "video": "...", "slides": "...",
        "report": "...", "infographic": "..."
      }
    }
  }
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.request
import urllib.error
from pathlib import Path

# Import conventions from agent/lib (sibling of agent/scripts)
_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent / "lib"))
import conventions as C  # noqa: E402

# Read Supabase creds from agent/.env (no exfil, local file only)
_ENV_PATH = _HERE.parent / ".env"


def _load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    if not _ENV_PATH.exists():
        return env
    for line in _ENV_PATH.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k] = v.strip().strip('"').strip("'")
    return env


_ENV = _load_env()
SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or _ENV.get("NEXT_PUBLIC_SUPABASE_URL")
KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or _ENV.get("SUPABASE_SERVICE_ROLE_KEY")
BUCKET = C.BUCKET

if not SUPABASE_URL or not KEY:
    print("ERROR: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set in env or agent/.env", file=sys.stderr)
    sys.exit(2)


# ── Supabase Storage REST helpers ────────────────────────────────────


def _supabase_request(method: str, path: str, body: dict | None = None, timeout: int = 60):
    headers = {
        "Authorization": f"Bearer {KEY}",
        "apikey": KEY,
        "Content-Type": "application/json",
    }
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        f"{SUPABASE_URL}{path}", data=data, headers=headers, method=method,
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def list_files(slug: str) -> list[str]:
    files = _supabase_request(
        "POST", f"/storage/v1/object/list/{BUCKET}",
        body={"prefix": slug, "limit": 200, "sortBy": {"column": "name", "order": "asc"}},
    )
    return [f["name"] for f in files]


def delete_files(slug: str, names: list[str]):
    if not names:
        return None
    return _supabase_request(
        "DELETE", f"/storage/v1/object/{BUCKET}",
        body={"prefixes": [f"{slug}/{n}" for n in names]},
    )


def move_file(slug: str, src_name: str, dst_name: str) -> int:
    headers = {
        "Authorization": f"Bearer {KEY}",
        "apikey": KEY,
        "Content-Type": "application/json",
    }
    body = json.dumps({
        "bucketId": BUCKET,
        "sourceKey": f"{slug}/{src_name}",
        "destinationKey": f"{slug}/{dst_name}",
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{SUPABASE_URL}/storage/v1/object/move",
        data=body, headers=headers, method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.status


# ── Plan computation ─────────────────────────────────────────────────


def _compact_ts(iso_ts: str) -> str:
    """2026-05-09T17-07-06 -> 20260509-170706"""
    if not iso_ts or "T" not in iso_ts:
        return iso_ts or ""
    bare = iso_ts.replace("-", "").replace("T", "")
    return f"{bare[:8]}-{bare[8:14]}"


def plan_for_slug(slug: str, cfg: dict) -> tuple[list[str], list[tuple[str, str]]]:
    """Return (deletions, moves) lists for one slug.

    cfg shape: {
        "topic_prefix": str,
        "iso_ts_in_filenames": str (e.g. "2026-05-09T17-07-06"),
        "research_ts_in_filenames": str (optional; defaults to iso_ts),
        "studio_titles": {"audio": str, "video": str, ...}
    }
    """
    files = list_files(slug)
    delete: list[str] = []
    moves: list[tuple[str, str]] = []
    iso_ts = cfg.get("iso_ts_in_filenames")
    research_ts = cfg.get("research_ts_in_filenames", iso_ts)
    compact_ts = _compact_ts(iso_ts) if iso_ts else ""

    for fn in files:
        # Noise: delete via conventions.is_skip_file
        if C.is_skip_file(fn):
            delete.append(fn)
            continue

        # Studio products: match {iso_ts}-{product}.{ext}, rename to title-slug version
        if iso_ts:
            m = re.match(rf"^{re.escape(iso_ts)}-([a-z]+)\.([a-z0-9]+)$", fn)
            if m:
                product, ext = m.group(1), m.group(2)
                titles = cfg.get("studio_titles") or {}
                if product in titles and product in C.STUDIO_PRODUCTS:
                    new_name = C.studio_filename(titles[product], compact_ts, product)
                    if new_name != fn:
                        moves.append((fn, new_name))
                continue

        # Research files: match {ts}-{role}.{ext} -> {topic-prefix}-{role}.{ext}
        for ts in dict.fromkeys([iso_ts, research_ts]):
            if not ts:
                continue
            m = re.match(rf"^{re.escape(ts)}-([a-z-]+)\.([a-z0-9]+)$", fn)
            if not m:
                continue
            role, ext = m.group(1), m.group(2)
            if role in C.RESEARCH_ROLES or role in C.RESEARCH_DOCX_ROLES:
                new_name = C.research_filename(cfg["topic_prefix"], role, ext)
                if new_name != fn:
                    moves.append((fn, new_name))
                break

    return delete, moves


# ── CLI ──────────────────────────────────────────────────────────────


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Apply S28 conventions to a Supabase Storage slug.")
    ap.add_argument("--config", help="Path to plan JSON (multi-slug batch mode)")
    ap.add_argument("--slug", help="One-shot mode: target slug")
    ap.add_argument("--topic-prefix", help="One-shot: research file topic-prefix")
    ap.add_argument("--iso-ts", help="One-shot: ISO ts substring in current filenames (e.g. 2026-05-09T17-07-06)")
    ap.add_argument("--research-ts", help="One-shot: research-file ts (defaults to --iso-ts)")
    ap.add_argument("--titles", help="One-shot: JSON mapping product→NLM title")
    ap.add_argument("--dry-run", action="store_true", help="Plan only, no Supabase writes")
    args = ap.parse_args(argv)

    if args.config:
        with open(args.config, "r", encoding="utf-8") as fh:
            slugs: dict = json.load(fh)
    elif args.slug:
        if not (args.topic_prefix and args.iso_ts and args.titles):
            ap.error("one-shot mode requires --slug --topic-prefix --iso-ts --titles")
        slugs = {
            args.slug: {
                "topic_prefix": args.topic_prefix,
                "iso_ts_in_filenames": args.iso_ts,
                "research_ts_in_filenames": args.research_ts or args.iso_ts,
                "studio_titles": json.loads(args.titles),
            }
        }
    else:
        ap.error("either --config or --slug (with one-shot args) required")
        return 2

    print(f"cleanup-supabase-naming.py | conventions v{C.VERSION} ({C.LAST_UPDATED})")
    print(f"  bucket: {BUCKET}")
    print(f"  dry-run: {args.dry_run}")

    total_deleted = 0
    total_moved = 0
    move_failures: list[tuple[str, str, str, int, str]] = []

    for slug, cfg in slugs.items():
        print(f"\n=== SLUG: {slug}")
        delete, moves = plan_for_slug(slug, cfg)

        print(f"  Delete: {len(delete)}")
        for n in delete:
            print(f"    - {n}")
        print(f"  Rename: {len(moves)}")
        for src, dst in moves:
            print(f"    - {src}")
            print(f"        -> {dst}")

        if args.dry_run:
            print("  (DRY_RUN - no changes)")
            continue

        if delete:
            try:
                delete_files(slug, delete)
                total_deleted += len(delete)
                print(f"  + deleted {len(delete)}")
            except urllib.error.HTTPError as e:
                print(f"  ! delete failed: {e.code} {e.read().decode()[:200]}")

        for src, dst in moves:
            try:
                move_file(slug, src, dst)
                total_moved += 1
            except urllib.error.HTTPError as e:
                move_failures.append((slug, src, dst, e.code, e.read().decode()[:120]))
        print(f"  + moved {len(moves) - sum(1 for f in move_failures if f[0] == slug)}/{len(moves)}")
        for s, src, dst, code, body in move_failures:
            if s == slug:
                print(f"    ! {src}->{dst}: HTTP {code} {body}")

    if not args.dry_run:
        print(f"\nDone. Total: deleted={total_deleted} moved={total_moved} failed_moves={len(move_failures)}")
    return 0 if not move_failures else 1


if __name__ == "__main__":
    sys.exit(main())
