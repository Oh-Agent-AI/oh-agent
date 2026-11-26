//! Native host routing labels for the built-in City plugin.
//! Keep City method names out of the generic plugin host surface.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LocalCall {
    LayoutPublish,
    Runtime,
    SourceExport,
}

pub(crate) fn classify_local_call(method: &str) -> Option<LocalCall> {
    if method == "creator.city.source.export" { return Some(LocalCall::SourceExport); }
    if method == "city.creator.layout.publish" { return Some(LocalCall::LayoutPublish); }
    if matches!(method,
        "city.creator.experiences.list" | "city.creator.experiences.read"
            | "city.creator.playtest.pending" | "city.creator.playtest.claim" | "city.creator.playtest.finish"
            | "city.creator.patch.publish" | "city.creator.patch.read"
            | "city.creator.world.package.snapshot.open" | "city.creator.world.package.snapshot.read"
            | "city.creator.world.package.snapshot.close" | "city.time.read" | "city.game.run.start"
            | "city.game.run.stop" | "city.story.read" | "city.story.commit"
            | "city.story.prepared.list" | "city.story.run.read" | "city.story.playtest.complete"
            | "city.story.schedule" | "city.story.cancel" | "city.story.list"
            | "city.story.intent.submit"
            | "city.code.preview.next" | "city.code.preview.read" | "city.code.preview.close") { return Some(LocalCall::Runtime); }
    None
}

pub(crate) fn is_playtest_call(method: &str) -> bool { method.starts_with("city.creator.playtest.") }
pub(crate) fn is_playtest_finish(method: &str) -> bool { method == "city.creator.playtest.finish" }

#[cfg(test)]
mod tests {
    use super::{classify_local_call, LocalCall};

    #[test]
    fn routes_only_declared_builtin_city_calls() {
        assert_eq!(classify_local_call("city.creator.world.package.snapshot.open"), Some(LocalCall::Runtime));
        assert_eq!(classify_local_call("city.time.read"), Some(LocalCall::Runtime));
        assert_eq!(classify_local_call("city.game.run.start"), Some(LocalCall::Runtime));
        assert_eq!(classify_local_call("city.story.commit"), Some(LocalCall::Runtime));
        assert_eq!(classify_local_call("city.story.prepared.list"), Some(LocalCall::Runtime));
        assert_eq!(classify_local_call("city.story.run.read"), Some(LocalCall::Runtime));
        assert_eq!(classify_local_call("city.story.playtest.complete"), Some(LocalCall::Runtime));
        assert_eq!(classify_local_call("city.story.intent.submit"), Some(LocalCall::Runtime));
        assert_eq!(classify_local_call("city.creator.layout.publish"), Some(LocalCall::LayoutPublish));
        assert_eq!(classify_local_call("creator.city.source.export"), Some(LocalCall::SourceExport));
        assert_eq!(classify_local_call("creator.project.read"), None);
        assert_eq!(classify_local_call("city.creator.unregistered"), None);
    }
}
