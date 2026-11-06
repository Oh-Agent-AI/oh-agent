# macOS installer artwork

The 640 × 400 Finder window places Oh Agent on the left and the real
`/Applications` shortcut on the right. The background provides the arrow and
installation instructions. Finder also supports copying the app and pasting it
into Applications with the keyboard.

Regenerate the 1× and 2× PNGs without a GUI:

```sh
swift scripts/render-macos-dmg-background.swift assets/installer
```

Both release entry points call `scripts/create-macos-dmg.sh`. Build-only Python
dependencies are hash-pinned and isolated under the desktop target directory.
Native Foundation bookmarks make the background resolve after remounting on
macOS 26; the completed image is mounted read-only to verify that bookmark,
Finder layout, Applications link, executable permissions and signatures before
replacing the previous installer. Do not add FinderInfo to the signed app itself.

The installer is generated before the final DMG notarization and stapling.
