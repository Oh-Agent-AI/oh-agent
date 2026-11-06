"""Build headlessly and replace the legacy background bookmark with native data."""
from pathlib import Path
import subprocess
import sys
import dmgbuild
from ds_store import DSStore, DSStoreEntry

scripts = Path(__file__).resolve().parent
mount = None


def progress(event):
    global mount
    if event.get("command") == "hdiutil::attach" and event["type"] == "command::finished":
        mount = next(Path(e["mount-point"]) for e in event["output"]["system-entities"] if "mount-point" in e)
    if event.get("operation") == "dsstore::create" and event["type"] == "operation::finished":
        background = next(mount.glob(".background.*"))
        native = subprocess.check_output(["swift", str(scripts / "macos-dmg-bookmark.swift"), "create", str(background)])
        with DSStore.open(str(mount / ".DS_Store"), "r+") as store:
            store.insert(DSStoreEntry(".", "pBBk", "blob", native))


dmgbuild.build_dmg(sys.argv[2], "Oh Agent", settings_file=str(scripts / "macos-dmg-settings.py"),
    defines={"app": sys.argv[1], "background": str(scripts.parent / "assets/installer/macos-background.png")}, callback=progress)
