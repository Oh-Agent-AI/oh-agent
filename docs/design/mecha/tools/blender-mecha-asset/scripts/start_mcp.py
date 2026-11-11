# Launch Blender with the official MCP add-on serving on localhost:9876, without touching user prefs:
#   /Applications/Blender.app/Contents/MacOS/Blender --online-mode --python start_mcp.py
# --online-mode is required: the add-on refuses to start its socket server when online access is off.
# The server can only be started from a timer (needs a window context), hence the delay.
import bpy


def _go():
    try:
        if "bl_ext.user_default.mcp" not in bpy.context.preferences.addons:
            bpy.ops.preferences.addon_enable(module="bl_ext.user_default.mcp")
        print("MCP_STARTED", bpy.ops.blmcp.server_start())
    except Exception as e:  # surfaces in the launch log; the MCP client will just fail to connect
        print("MCP_FAIL", repr(e))
    return None


bpy.app.timers.register(_go, first_interval=2.5)
