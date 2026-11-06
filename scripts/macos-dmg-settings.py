"""Finder presentation shared by local and CI releases; no Finder automation."""
from pathlib import Path

app = Path(defines["app"]).resolve()
if app.name != "Oh Agent.app" or not app.is_dir():
    raise ValueError("expected an existing Oh Agent.app")

format = "UDZO"
filesystem = "HFS+"
files = [str(app)]
symlinks = {"Applications": "/Applications"}
background = str(Path(defines["background"]).resolve(strict=True))
icon_locations = {"Oh Agent.app": (175, 200), "Applications": (465, 200)}
window_rect = ((160, 180), (640, 400))
default_view = "icon-view"
icon_size = 104
text_size = 14
label_pos = "bottom"
arrange_by = None
grid_spacing = 64
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
# Do not SetFile the signed app to hide its extension: adding FinderInfo to a
# signed bundle invalidates strict codesign verification. Finder handles .app.
hide_extensions = []
include_icon_view_settings = True
include_list_view_settings = False
