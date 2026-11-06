#!/usr/bin/env python3
"""Check or refresh legacy public price mirrors, only catalog/pricing -> assets."""
import argparse
import os
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FILES = ("pricing.json", "codex_pricing.json", "pricing-sync.json")
MAX_BYTES = 4 * 1024 * 1024


def _regular(path, root, missing=False):
    for candidate in (path,) + tuple(path.parents):
        if candidate == root:
            break
        if candidate.is_symlink():
            raise ValueError("catalog mirror refuses symlink: %s" % candidate)
    if missing and not path.exists():
        return
    if not path.is_file():
        raise ValueError("catalog mirror missing regular file: %s" % path)


def atomic_bytes(path, data):
    """Replace one mirror atomically. Publishing still requires a whole-set check."""
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".catalog-", delete=False) as stream:
        temporary = Path(stream.name)
        try:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        except BaseException:
            temporary.unlink()
            raise
    try:
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def validate_paths(root=ROOT, allow_missing_mirrors=False):
    root = Path(root).resolve()
    for name in FILES:
        _regular(root / "catalog/pricing" / name, root)
        _regular(root / "assets" / name, root, missing=allow_missing_mirrors)


def synchronize(root=ROOT, write=False):
    root = Path(root).resolve()
    validate_paths(root, allow_missing_mirrors=write)
    candidates = []
    # Validate every source/path before any writes; never reconstruct authority from assets.
    for name in FILES:
        source, target = root / "catalog/pricing" / name, root / "assets" / name
        _regular(source, root)
        _regular(target, root, missing=write)
        if source.stat().st_size > MAX_BYTES:
            raise ValueError("catalog mirror source bytes limit: %s" % source)
        with source.open("rb") as stream:
            content = stream.read(MAX_BYTES + 1)
        if len(content) > MAX_BYTES:
            raise ValueError("catalog mirror source bytes limit: %s" % source)
        matches = target.exists() and target.stat().st_size == len(content) and target.read_bytes() == content
        if not matches:
            candidates.append((target, content))
    if candidates and not write:
        raise ValueError("catalog mirror drift: " + ", ".join(path.relative_to(root).as_posix() for path, _ in candidates))
    for target, content in candidates:
        atomic_bytes(target, content)
    return [path.relative_to(root).as_posix() for path, _ in candidates]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--write", action="store_true", help="refresh assets from catalog authority")
    args = parser.parse_args(argv)
    try:
        changed = synchronize(args.root, args.write)
        print("catalog price mirrors: " + ("refreshed " + ", ".join(changed) if changed else "identical"))
        return 0
    except (ValueError, OSError) as error:
        parser.exit(1, str(error) + "\n")


if __name__ == "__main__":
    raise SystemExit(main())
