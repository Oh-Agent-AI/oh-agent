"""Inspect the actual read-only volume, including Finder metadata and signed code."""
import os
import plistlib
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from ds_store import DSStore


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


def verify(volume):
    app = volume / "Oh Agent.app"
    applications = volume / "Applications"
    check(app.is_dir(), "missing Oh Agent.app")
    check(applications.is_symlink() and os.readlink(applications) == "/Applications", "invalid Applications shortcut")
    check((volume / ".DS_Store").is_file(), "missing Finder layout")
    with DSStore.open(str(volume / ".DS_Store"), "r") as store:
        check(store["Oh Agent.app"]["Iloc"] == (175, 200), "incorrect app position")
        check(store["Applications"]["Iloc"] == (465, 200), "incorrect Applications position")
        window = store["."]["bwsp"]
        check("640, 400" in window["WindowBounds"], "incorrect installer window size")
        check(not window["ShowToolbar"] and not window["ShowSidebar"], "unexpected Finder chrome")
        icons = store["."]["icvp"]
        check(icons["backgroundType"] == 2 and icons["iconSize"] == 104, "missing background/icon settings")
        bookmark = store["."]["pBBk"].to_bytes()
    with tempfile.TemporaryDirectory(prefix="oh-agent-bookmark-") as temporary:
        record = Path(temporary) / "bookmark"
        record.write_bytes(bookmark)
        resolved = subprocess.check_output(["swift", str(Path(__file__).with_name("macos-dmg-bookmark.swift")), "resolve", str(record)], text=True).strip()
        check(Path(resolved).parent == volume, "background bookmark resolved outside this installer")
    check(any(p.name.startswith(".background") for p in volume.iterdir()), "background not embedded in volume")
    for binary in [app / "Contents/MacOS/agent-vitals-menubar", app / "Contents/Resources/bin/agent-vitals"]:
        check(binary.is_file() and os.access(binary, os.X_OK), "missing executable: " + binary.name)
    for code in [app, app / "Contents/Resources/bin/agent-vitals"]:
        subprocess.run(["codesign", "--verify", "--strict", str(code)], check=True)
    print("macOS DMG: Applications shortcut, Finder positions/window/background, executable permissions and signatures passed")


def main():
    image = str(Path(sys.argv[1]).resolve(strict=True))
    with tempfile.TemporaryDirectory(prefix="oh-agent-dmg-check-") as temporary:
        volume = Path(temporary).resolve() / "volume"
        attached = False
        try:
            output = subprocess.check_output(["hdiutil", "attach", "-readonly", "-nobrowse", "-mountpoint", str(volume), "-plist", image])
            attached = True
            check(any(e.get("mount-point") == str(volume) for e in plistlib.loads(output)["system-entities"]), "unexpected mount point")
            verify(volume)
        finally:
            if attached:
                for attempt in range(3):
                    result = subprocess.run(["hdiutil", "detach", str(volume)], stdout=subprocess.DEVNULL)
                    if result.returncode == 0:
                        break
                    time.sleep(1)
                else:
                    raise RuntimeError("could not detach installer verification volume")


if __name__ == "__main__":
    main()
