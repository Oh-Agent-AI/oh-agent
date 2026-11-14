//! Native placement of plugin child WebViews inside the workbench window.
//!
//! macOS and Windows: `Window::add_child` creates a real child view, and
//! `Webview::set_bounds` positions it in window-content coordinates.
//!
//! Linux (WebKitGTK): tauri-runtime-wry builds every `WindowChild` WebView with
//! `build_gtk(default_vbox)`, i.e. `gtk::Box::pack_start(child, expand, fill)`.
//! The host WebView and each plugin WebView therefore become stacked siblings of
//! a vertical box, which splits the window height between them (the plugin
//! fills the full window width of the lower half and covers the sidebar).
//! wry's `set_bounds` only moves widgets placed in a `gtk::Fixed` (or X11
//! child windows), so the bounds requested by the frontend are silently
//! ignored. We fix that by moving the host WebView into a `gtk::Overlay`
//! (which takes the host's place in the box, so the menu bar offset stays
//! correct) and adding each plugin WebView as an overlay child positioned with
//! margins + size request in the same logical (CSS px) coordinate space the
//! frontend reports via `getBoundingClientRect`.

/// Integer GTK geometry (logical pixels) for an overlay child.
// Only the Linux placement path consumes this; other platforms keep it for tests.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ChildGeometry { pub x: i32, pub y: i32, pub width: i32, pub height: i32 }

/// Convert frontend logical bounds (CSS px, relative to the host WebView
/// viewport) into GTK overlay geometry. Edges are rounded independently so
/// adjacent fractional rects never leave a gap; negative origins are clamped
/// to the overlay and the size never collapses below 1px (GTK treats a size
/// request of 0 as "no window", -1 as "unset").
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn overlay_child_geometry(x: f64, y: f64, width: f64, height: f64) -> ChildGeometry {
    fn finite(v: f64) -> f64 { if v.is_finite() { v } else { 0.0 } }
    let (x, y, width, height) = (finite(x), finite(y), finite(width).max(0.0), finite(height).max(0.0));
    let left = x.round().max(0.0);
    let top = y.round().max(0.0);
    let right = (x + width).round().max(left + 1.0);
    let bottom = (y + height).round().max(top + 1.0);
    let clamp = |v: f64| v.min(i32::MAX as f64) as i32;
    ChildGeometry { x: clamp(left), y: clamp(top), width: clamp(right - left), height: clamp(bottom - top) }
}

#[cfg(target_os = "linux")]
pub(crate) mod linux {
    use super::ChildGeometry;
    use gtk::prelude::*;

    const OVERLAY_NAME: &str = "oh-agent-plugin-overlay";

    fn log_error(message: &str) { agent_vitals_runtime::logging::log_error("plugin_host", message); }

    /// Reparent a freshly created plugin WebView into the host overlay and
    /// place it. Runs on the GTK main thread via `with_webview`.
    pub(crate) fn adopt(view: &tauri::Webview, geometry: ChildGeometry) -> Result<(), String> {
        view.with_webview(move |platform| {
            let child: gtk::Widget = platform.inner().upcast();
            if let Err(error) = adopt_widget(&child, geometry) {
                log_error(&format!("plugin overlay attach failed: {error}"));
            }
        }).map_err(|_| "plugin_layout_failed".to_owned())
    }

    /// Move/resize an already adopted plugin WebView.
    pub(crate) fn set_bounds(view: &tauri::Webview, geometry: ChildGeometry) -> Result<(), String> {
        view.with_webview(move |platform| {
            let child: gtk::Widget = platform.inner().upcast();
            let adopted = child.parent().is_some_and(|parent| parent.widget_name() == OVERLAY_NAME);
            if adopted { apply(&child, geometry); }
            else if let Err(error) = adopt_widget(&child, geometry) {
                log_error(&format!("plugin overlay attach failed: {error}"));
            }
        }).map_err(|_| "plugin_layout_failed".to_owned())
    }

    fn apply(child: &gtk::Widget, g: ChildGeometry) {
        child.set_halign(gtk::Align::Start);
        child.set_valign(gtk::Align::Start);
        child.set_hexpand(false);
        child.set_vexpand(false);
        child.set_margin_start(g.x);
        child.set_margin_top(g.y);
        child.set_margin_end(0);
        child.set_margin_bottom(0);
        child.set_size_request(g.width, g.height);
        child.queue_resize();
    }

    fn adopt_widget(child: &gtk::Widget, geometry: ChildGeometry) -> Result<(), &'static str> {
        let parent = child.parent().ok_or("plugin webview has no parent")?;
        if parent.widget_name() == OVERLAY_NAME { apply(child, geometry); return Ok(()); }
        let vbox = parent.downcast::<gtk::Box>().map_err(|_| "unexpected plugin webview container")?;
        let existing = vbox.children().into_iter().find(|w| w.widget_name() == OVERLAY_NAME);
        let overlay = match existing {
            Some(widget) => widget.downcast::<gtk::Overlay>().map_err(|_| "overlay type mismatch")?,
            None => {
                // The host WebView was packed when the window was built, so it is
                // the first WebKit sibling; plugin views are adopted on creation.
                let host = vbox.children().into_iter()
                    .find(|w| w != child && w.type_() == child.type_())
                    .ok_or("host webview not found")?;
                let position = vbox.child_position(&host);
                let overlay = gtk::Overlay::new();
                overlay.set_widget_name(OVERLAY_NAME);
                vbox.remove(&host);
                overlay.add(&host);
                vbox.pack_start(&overlay, true, true, 0);
                vbox.reorder_child(&overlay, position);
                overlay.show();
                overlay
            }
        };
        let visible = child.is_visible();
        vbox.remove(child);
        apply(child, geometry);
        overlay.add_overlay(child);
        child.set_visible(visible);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integer_bounds_map_one_to_one() {
        assert_eq!(overlay_child_geometry(102.0, 40.0, 488.0, 380.0), ChildGeometry { x: 102, y: 40, width: 488, height: 380 });
    }

    #[test]
    fn fractional_edges_round_independently_without_gaps() {
        // A slot starting at 100.4 and ending at 300.6 covers pixels 100..301.
        assert_eq!(overlay_child_geometry(100.4, 39.5, 200.2, 100.0), ChildGeometry { x: 100, y: 40, width: 201, height: 100 });
        // Adjacent rects share the rounded edge.
        let a = overlay_child_geometry(0.0, 0.0, 100.5, 10.0);
        let b = overlay_child_geometry(100.5, 0.0, 50.0, 10.0);
        assert_eq!(a.x + a.width, b.x);
    }

    #[test]
    fn negative_origin_is_clamped_and_size_never_collapses() {
        assert_eq!(overlay_child_geometry(-5.0, -3.0, 0.0, 0.0), ChildGeometry { x: 0, y: 0, width: 1, height: 1 });
        assert_eq!(overlay_child_geometry(10.0, 10.0, -20.0, 5.0), ChildGeometry { x: 10, y: 10, width: 1, height: 5 });
    }

    #[test]
    fn non_finite_values_degrade_to_a_minimal_rect() {
        assert_eq!(overlay_child_geometry(f64::NAN, f64::INFINITY, f64::NAN, 10.0), ChildGeometry { x: 0, y: 0, width: 1, height: 10 });
    }
}
