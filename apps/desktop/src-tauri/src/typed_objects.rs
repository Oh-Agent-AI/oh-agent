//! Descriptor-granted generic object requests. The plugin host supplies the
//! exact verified plugin grant; object bodies remain opaque to Rust.

use agent_vitals_runtime::query::object_store::{
    AliasBinding, CommitResult, DeleteResult, ObjectGrant, ObjectListPage, ObjectStore, PendingEvent,
    ScopeCommitResult, ScopeGrant, ScopeMemberRef,
};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::Path};

const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

fn has_only_keys(value: &Value, required: &[&str], optional: &[&str]) -> bool {
    value.as_object().is_some_and(|object| required.iter().all(|key| object.contains_key(*key))
        && object.keys().all(|key| required.contains(&key.as_str()) || optional.contains(&key.as_str())))
}

/// Execute the fixed `typed-object.request` contract after `plugin_host` has
/// authenticated the active WebView and selected grants from its descriptor.
pub(crate) fn request_for_plugin(
    grants: &BTreeMap<String, ObjectGrant>,
    scope_grants: &BTreeMap<String, ScopeGrant>,
    home: &Path,
    plugin_id: &str,
    payload: &Value,
) -> Result<Value, &'static str> {
    let encoded = serde_json::to_vec(payload).map_err(|_| "typed_object_invalid_request")?;
    if encoded.len() > MAX_REQUEST_BYTES { return Err("typed_object_too_large"); }
    if payload["version"].as_u64() != Some(1) { return Err("typed_object_invalid_request"); }
    let operation = payload["operation"].as_str().ok_or("typed_object_invalid_request")?;
    let (required, optional): (&[&str], &[&str]) = match operation {
        "create" => (&["version", "operation", "objectType", "schemaVersion", "body", "idempotencyKey"], &["alias"]),
        "read" => (&["version", "operation", "objectType", "handle"], &[]),
        "readAlias" => (&["version", "operation", "objectType", "alias"], &[]),
        "attachAlias" => (&["version", "operation", "objectType", "handle", "alias", "idempotencyKey"], &[]),
        "commit" => (&["version", "operation", "objectType", "handle", "expectedRevision", "body", "events", "idempotencyKey"], &[]),
        "eventPage" => (&["version", "operation", "objectType", "handle"], &["afterCursor", "limit"]),
        "list" => (&["version", "operation", "objectType", "schemaVersion"], &["afterCursor", "limit", "aliases", "handles"]),
        "delete" => (&["version", "operation", "objectType", "handle", "expectedRevision", "idempotencyKey"], &[]),
        "scopeRead" => (&["version", "operation", "scopeType", "scopeHandle"], &[]),
        "scopeCommit" => (&["version", "operation", "scopeType", "expectedRevision", "members", "idempotencyKey"], &["scopeHandle"]),
        _ => return Err("typed_object_operation_denied"),
    };
    if !has_only_keys(payload, required, optional) { return Err("typed_object_invalid_request"); }
    if operation == "scopeRead" || operation == "scopeCommit" {
        let scope_type = payload["scopeType"].as_str().ok_or("typed_object_invalid_request")?;
        let grant = scope_grants.get(scope_type).filter(|grant| grant.validate_for(scope_type, grants).is_ok())
            .ok_or("typed_object_denied")?;
        let grant_op = if operation == "scopeRead" { "read" } else { "commit" };
        if !grant.operations.iter().any(|allowed| allowed == grant_op) { return Err("typed_object_denied"); }
        let mut store = ObjectStore::open(home, plugin_id).map_err(|error| error.code())?;
        let result = if operation == "scopeRead" {
            let handle = payload["scopeHandle"].as_str().ok_or("typed_object_invalid_request")?;
            store.read_scope(grant, scope_type, handle, grants).map(|scope| json!({"schema":"plugin-object:v1","scope":scope}))
        } else {
            let handle = payload.get("scopeHandle").and_then(Value::as_str);
            let expected = payload["expectedRevision"].as_u64().filter(|revision| *revision <= 9_007_199_254_740_991)
                .ok_or("typed_object_invalid_request")?;
            let key = payload["idempotencyKey"].as_str().ok_or("typed_object_invalid_request")?;
            let members = serde_json::from_value::<Vec<ScopeMemberRef>>(payload["members"].clone()).map_err(|_| "typed_object_invalid_request")?;
            store.commit_scope(grant, scope_type, handle, expected, &members, key, grants)
                .map(|commit: ScopeCommitResult| json!({"schema":"plugin-object:v1","commit":commit}))
        }.map_err(|error| error.code())?;
        let response_bytes = serde_json::to_vec(&result).map_err(|_| "typed_object_unavailable")?;
        if response_bytes.len() > MAX_RESPONSE_BYTES { return Err("typed_object_too_large"); }
        return Ok(result);
    }
    let object_type = payload["objectType"].as_str().ok_or("typed_object_invalid_request")?;
    let grant = grants.get(object_type).filter(|grant| grant.validate_for(object_type).is_ok())
        .ok_or("typed_object_denied")?;
    if !grant.operations.iter().any(|allowed| allowed == operation) { return Err("typed_object_denied"); }
    let mut store = ObjectStore::open(home, plugin_id).map_err(|error| error.code())?;
    let result = match operation {
        "create" => {
            let schema_version = payload["schemaVersion"].as_u64().and_then(|value| u32::try_from(value).ok())
                .ok_or("typed_object_invalid_request")?;
            let body = &payload["body"];
            let idempotency_key = payload["idempotencyKey"].as_str().ok_or("typed_object_invalid_request")?;
            let alias = payload.get("alias").and_then(Value::as_str);
            if payload.get("alias").is_some() && alias.is_none() { return Err("typed_object_invalid_request"); }
            let object = store.create_with_alias(grant, schema_version, body, alias, idempotency_key).map_err(|error| error.code())?;
            json!({"schema":"plugin-object:v1","object":object})
        }
        "read" => {
            let handle = payload["handle"].as_str().ok_or("typed_object_invalid_request")?;
            let object = store.read(grant, handle).map_err(|error| error.code())?;
            json!({"schema":"plugin-object:v1","object":object})
        }
        "readAlias" => {
            let alias = payload["alias"].as_str().ok_or("typed_object_invalid_request")?;
            let object = store.read_alias(grant, alias).map_err(|error| error.code())?;
            json!({"schema":"plugin-object:v1","object":object})
        }
        "attachAlias" => {
            let handle = payload["handle"].as_str().ok_or("typed_object_invalid_request")?;
            let alias = payload["alias"].as_str().ok_or("typed_object_invalid_request")?;
            let idempotency_key = payload["idempotencyKey"].as_str().ok_or("typed_object_invalid_request")?;
            let binding: AliasBinding = store.attach_alias(grant, handle, alias, idempotency_key)
                .map_err(|error| error.code())?;
            json!({"schema":"plugin-object:v1","aliasBinding":binding})
        }
        "commit" => {
            let handle = payload["handle"].as_str().ok_or("typed_object_invalid_request")?;
            let expected_revision = payload["expectedRevision"].as_u64().filter(|revision| *revision <= 9_007_199_254_740_991)
                .ok_or("typed_object_invalid_request")?;
            let idempotency_key = payload["idempotencyKey"].as_str().ok_or("typed_object_invalid_request")?;
            let pending = serde_json::from_value::<Vec<PendingEvent>>(payload["events"].clone()).map_err(|_| "typed_object_invalid_request")?;
            let commit: CommitResult = store.commit(grant, handle, expected_revision, &payload["body"], &pending, idempotency_key)
                .map_err(|error| error.code())?;
            json!({"schema":"plugin-object:v1","commit":commit})
        }
        "eventPage" => {
            let handle = payload["handle"].as_str().ok_or("typed_object_invalid_request")?;
            let after_cursor = match payload.get("afterCursor").unwrap_or(&Value::Null) {
                Value::Null => None,
                Value::String(cursor) => Some(cursor.as_str()),
                _ => return Err("typed_object_invalid_request"),
            };
            let limit = payload.get("limit").and_then(Value::as_u64).and_then(|value| usize::try_from(value).ok())
                .unwrap_or(grant.max_event_page);
            let page = store.event_page(grant, handle, after_cursor, limit).map_err(|error| error.code())?;
            json!({"schema":"plugin-object:v1","page":page})
        }
        "list" => {
            let schema_version = payload["schemaVersion"].as_u64().and_then(|value| u32::try_from(value).ok())
                .ok_or("typed_object_invalid_request")?;
            if payload.get("aliases").is_some() && payload.get("handles").is_some() { return Err("typed_object_invalid_request"); }
            if let Some(aliases) = payload.get("aliases") {
                let aliases = serde_json::from_value::<Vec<String>>(aliases.clone()).map_err(|_| "typed_object_invalid_request")?;
                let page: ObjectListPage = store.list_by_aliases(grant, schema_version, &aliases, aliases.len().max(1))
                    .map_err(|error| error.code())?;
                json!({"schema":"plugin-object:v1","page":page})
            } else if let Some(handles) = payload.get("handles") {
                let handles = serde_json::from_value::<Vec<String>>(handles.clone()).map_err(|_| "typed_object_invalid_request")?;
                let page: ObjectListPage = store.list_by_handles(grant, schema_version, &handles, handles.len().max(1))
                    .map_err(|error| error.code())?;
                json!({"schema":"plugin-object:v1","page":page})
            } else {
                let cursor = match payload.get("afterCursor").unwrap_or(&Value::Null) {
                    Value::Null => None,
                    Value::String(value) => Some(value.as_str()),
                    _ => return Err("typed_object_invalid_request"),
                };
                let limit = payload.get("limit").and_then(Value::as_u64).and_then(|value| usize::try_from(value).ok()).unwrap_or(grant.max_list_page);
                let page: ObjectListPage = store.list(grant, schema_version, cursor, limit).map_err(|error| error.code())?;
                json!({"schema":"plugin-object:v1","page":page})
            }
        }
        "delete" => {
            let handle = payload["handle"].as_str().ok_or("typed_object_invalid_request")?;
            let expected = payload["expectedRevision"].as_u64().filter(|revision| *revision <= 9_007_199_254_740_991)
                .ok_or("typed_object_invalid_request")?;
            let key = payload["idempotencyKey"].as_str().ok_or("typed_object_invalid_request")?;
            let commit: DeleteResult = store.delete(grant, handle, expected, key).map_err(|error| error.code())?;
            json!({"schema":"plugin-object:v1","commit":commit})
        }
        _ => return Err("typed_object_operation_denied"),
    };
    let response_bytes = serde_json::to_vec(&result).map_err(|_| "typed_object_unavailable")?;
    if response_bytes.len() > MAX_RESPONSE_BYTES { return Err("typed_object_too_large"); }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{path::PathBuf, sync::atomic::{AtomicU64, Ordering}};

    fn grant(type_id: &str) -> ObjectGrant {
        ObjectGrant {
            object_type:type_id.into(),schema_version:1,allow_aliases:false,
            operations:vec!["create".into(),"read".into(),"commit".into(),"eventPage".into(),"list".into(),"delete".into()],
            max_object_bytes:2048,max_objects:8,max_total_bytes:8192,max_event_bytes:512,
            max_events_per_object:8,max_events_per_commit:4,max_event_page:2,max_list_page:2,
            event_types:vec!["record.changed".into()],
        }
    }

    fn home() -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let id = NEXT.fetch_add(1,Ordering::Relaxed);
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        std::env::temp_dir().join(format!("typed-object-tauri-{}-{now}-{id}",std::process::id()))
    }

    fn create(type_id: &str, key: &str) -> Value {
        json!({"version":1,"operation":"create","objectType":type_id,"schemaVersion":1,"body":{"value":1},"idempotencyKey":key})
    }

    #[test]
    fn descriptor_grant_gates_operations_types_schema_and_plugin_scope() {
        let home = home();
        let grants = BTreeMap::from([("test.record:v1".into(),grant("test.record:v1"))]);
        let first = request_for_plugin(&grants,&BTreeMap::new(),&home,"first-app",&create("test.record:v1","create-1")).unwrap();
        assert_eq!(first["schema"],"plugin-object:v1");
        let handle = first["object"]["handle"].as_str().unwrap();
        let read = json!({"version":1,"operation":"read","objectType":"test.record:v1","handle":handle});
        assert_eq!(request_for_plugin(&grants,&BTreeMap::new(),&home,"first-app",&read).unwrap()["object"]["body"]["value"],1);
        assert_eq!(request_for_plugin(&grants,&BTreeMap::new(),&home,"second-app",&read),Err("object_unavailable"));
        assert_eq!(request_for_plugin(&grants,&BTreeMap::new(),&home,"first-app",&create("unknown:v1","unknown")),Err("typed_object_denied"));
        let mut wrong_schema = create("test.record:v1","wrong-schema");
        wrong_schema["schemaVersion"] = json!(2);
        assert_eq!(request_for_plugin(&grants,&BTreeMap::new(),&home,"first-app",&wrong_schema),Err("invalid_schema_version"));
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn aliases_are_descriptor_opt_in_and_use_generic_read_alias_operation() {
        let home = home();
        let mut allowed = grant("test.record:v1");
        allowed.allow_aliases = true;
        allowed.operations.push("readAlias".into());
        let grants = BTreeMap::from([("test.record:v1".into(),allowed.clone())]);
        let create = json!({"version":1,"operation":"create","objectType":"test.record:v1","schemaVersion":1,
            "body":{"value":1},"alias":"ca_legacy-123","idempotencyKey":"create-aliased"});
        let created = request_for_plugin(&grants,&BTreeMap::new(),&home,"first-app",&create).unwrap();
        assert_eq!(created["object"]["alias"],"ca_legacy-123");
        let lookup = json!({"version":1,"operation":"readAlias","objectType":"test.record:v1","alias":"ca_legacy-123"});
        assert_eq!(request_for_plugin(&grants,&BTreeMap::new(),&home,"first-app",&lookup).unwrap()["object"],created["object"]);
        let mut denied = grant("test.record:v1");
        let denied_grants = BTreeMap::from([("test.record:v1".into(),denied.clone())]);
        assert_eq!(request_for_plugin(&denied_grants,&BTreeMap::new(),&home,"second-app",&create),Err("alias_denied"));
        denied.allow_aliases = true;
        denied.operations.push("readAlias".into());
        let invalid_lookup = json!({"version":1,"operation":"readAlias","objectType":"test.record:v1","alias":"../secret"});
        assert_eq!(request_for_plugin(&BTreeMap::from([("test.record:v1".into(),denied)]),&BTreeMap::new(),&home,"first-app",&invalid_lookup),Err("invalid_alias"));
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn secondary_alias_operation_is_explicit_transactional_and_grant_scoped() {
        let home = home();
        let mut allowed = grant("test.record:v1");
        allowed.allow_aliases = true;
        allowed.operations.extend(["readAlias".into(),"attachAlias".into()]);
        let grants = BTreeMap::from([("test.record:v1".into(),allowed.clone())]);
        let created = request_for_plugin(&grants,&BTreeMap::new(),&home,"first-app",&create("test.record:v1","create-unaliased")).unwrap();
        let handle = created["object"]["handle"].as_str().unwrap();
        let attach = json!({"version":1,"operation":"attachAlias","objectType":"test.record:v1","handle":handle,
            "alias":"src_legacy-1","idempotencyKey":"attach-1"});
        let attached = request_for_plugin(&grants,&BTreeMap::new(),&home,"first-app",&attach).unwrap();
        assert_eq!(attached["aliasBinding"],json!({"handle":handle,"alias":"src_legacy-1"}));
        let mut retry = attach.clone();
        retry["idempotencyKey"] = json!("attach-retry");
        assert_eq!(request_for_plugin(&grants,&BTreeMap::new(),&home,"first-app",&retry).unwrap(),attached);
        let lookup = json!({"version":1,"operation":"readAlias","objectType":"test.record:v1","alias":"src_legacy-1"});
        assert_eq!(request_for_plugin(&grants,&BTreeMap::new(),&home,"first-app",&lookup).unwrap()["object"]["handle"],handle);

        let mut no_attach = allowed.clone();
        no_attach.operations.retain(|operation| operation != "attachAlias");
        assert_eq!(request_for_plugin(&BTreeMap::from([("test.record:v1".into(),no_attach)]),&BTreeMap::new(),&home,"first-app",&attach),Err("typed_object_denied"));
        let mut extra_key = attach.clone();
        extra_key["surprise"] = json!(true);
        assert_eq!(request_for_plugin(&grants,&BTreeMap::new(),&home,"first-app",&extra_key),Err("typed_object_invalid_request"));
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn request_shapes_limits_revision_events_and_cursors_are_checked() {
        let home = home();
        let grants = BTreeMap::from([("test.record:v1".into(),grant("test.record:v1"))]);
        let create_result = request_for_plugin(&grants,&BTreeMap::new(),&home,"first-app",&create("test.record:v1","create-1")).unwrap();
        let handle = create_result["object"]["handle"].as_str().unwrap();
        let mut extra = create("test.record:v1","bad-shape");
        extra["arbitrary"] = json!(true);
        assert_eq!(request_for_plugin(&grants,&BTreeMap::new(),&home,"first-app",&extra),Err("typed_object_invalid_request"));
        let oversized = create("test.record:v1","too-large");
        let mut oversized = oversized;
        oversized["body"] = json!({"blob":"x".repeat(MAX_REQUEST_BYTES)});
        assert_eq!(request_for_plugin(&grants,&BTreeMap::new(),&home,"first-app",&oversized),Err("typed_object_too_large"));
        let stale = json!({"version":1,"operation":"commit","objectType":"test.record:v1","handle":handle,"expectedRevision":9,
            "body":{"value":2},"events":[],"idempotencyKey":"stale"});
        assert_eq!(request_for_plugin(&grants,&BTreeMap::new(),&home,"first-app",&stale),Err("revision_conflict"));
        let over = json!({"version":1,"operation":"commit","objectType":"test.record:v1","handle":handle,"expectedRevision":1,
            "body":{"value":2},"events":[{"eventType":"ungranted","body":{}}],"idempotencyKey":"bad-event"});
        assert_eq!(request_for_plugin(&grants,&BTreeMap::new(),&home,"first-app",&over),Err("invalid_event"));
        let page = json!({"version":1,"operation":"eventPage","objectType":"test.record:v1","handle":handle,"afterCursor":null,"limit":3});
        assert_eq!(request_for_plugin(&grants,&BTreeMap::new(),&home,"first-app",&page),Err("invalid_page"));
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn list_delete_and_scope_wire_operations_are_descriptor_scoped() {
        let home = home();
        let grants = BTreeMap::from([("test.record:v1".into(),grant("test.record:v1"))]);
        let scopes = BTreeMap::from([("test.save:v1".into(),ScopeGrant {
            scope_type:"test.save:v1".into(),operations:vec!["read".into(),"commit".into()],
            object_types:vec!["test.record:v1".into()],max_scopes:8,max_members:8,
        })]);
        let object = request_for_plugin(&grants,&scopes,&home,"first-app",&create("test.record:v1","create-1")).unwrap();
        let handle = object["object"]["handle"].as_str().unwrap().to_owned();
        let list = json!({"version":1,"operation":"list","objectType":"test.record:v1","schemaVersion":1,"limit":2});
        assert_eq!(request_for_plugin(&grants,&scopes,&home,"first-app",&list).unwrap()["page"]["objects"][0]["handle"],handle);
        let scope_commit = json!({"version":1,"operation":"scopeCommit","scopeType":"test.save:v1","expectedRevision":0,
            "members":[{"objectType":"test.record:v1","handle":handle}],"idempotencyKey":"scope-create"});
        let commit = request_for_plugin(&grants,&scopes,&home,"first-app",&scope_commit).unwrap();
        let scope_handle = commit["commit"]["scopeHandle"].as_str().unwrap().to_owned();
        let scope_read = json!({"version":1,"operation":"scopeRead","scopeType":"test.save:v1","scopeHandle":scope_handle});
        assert_eq!(request_for_plugin(&grants,&scopes,&home,"first-app",&scope_read).unwrap()["scope"]["members"].as_array().unwrap().len(),1);
        assert_eq!(request_for_plugin(&grants,&scopes,&home,"second-app",&scope_read),Err("scope_unavailable"));
        let denied_scope = json!({"version":1,"operation":"scopeCommit","scopeType":"unknown:v1","expectedRevision":0,"members":[],"idempotencyKey":"denied"});
        assert_eq!(request_for_plugin(&grants,&scopes,&home,"first-app",&denied_scope),Err("typed_object_denied"));
        let delete = json!({"version":1,"operation":"delete","objectType":"test.record:v1","handle":object["object"]["handle"],"expectedRevision":1,"idempotencyKey":"delete-1"});
        assert_eq!(request_for_plugin(&grants,&scopes,&home,"first-app",&delete).unwrap()["commit"]["deleted"],true);
        assert_eq!(request_for_plugin(&grants,&scopes,&home,"first-app",&scope_read).unwrap()["scope"]["members"][0]["deleted"],true);
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn list_uses_after_cursor_and_bounded_alias_filter_contract() {
        let home = home();
        let mut allowed = grant("test.record:v1");
        allowed.allow_aliases = true;
        let grants = BTreeMap::from([("test.record:v1".into(),allowed)]);
        let mut first = create("test.record:v1","create-first");
        first["alias"] = json!("src_first");
        request_for_plugin(&grants,&BTreeMap::new(),&home,"first-app",&first).unwrap();
        let mut second = create("test.record:v1","create-second");
        second["alias"] = json!("src_second");
        let second = request_for_plugin(&grants,&BTreeMap::new(),&home,"first-app",&second).unwrap();
        let second_handle = second["object"]["handle"].as_str().unwrap();

        let alias_list = json!({"version":1,"operation":"list","objectType":"test.record:v1","schemaVersion":1,
            "aliases":["src_second"]});
        let page = request_for_plugin(&grants,&BTreeMap::new(),&home,"first-app",&alias_list).unwrap();
        assert_eq!(page["page"]["objects"].as_array().unwrap().len(),1);
        assert_eq!(page["page"]["objects"][0]["handle"],second_handle);
        assert_eq!(page["page"]["hasMore"],false);

        let handle_list = json!({"version":1,"operation":"list","objectType":"test.record:v1","schemaVersion":1,
            "handles":[second_handle]});
        let page = request_for_plugin(&grants,&BTreeMap::new(),&home,"first-app",&handle_list).unwrap();
        assert_eq!(page["page"]["objects"].as_array().unwrap().len(),1);
        assert_eq!(page["page"]["objects"][0]["handle"],second_handle);
        let ambiguous_list = json!({"version":1,"operation":"list","objectType":"test.record:v1","schemaVersion":1,
            "aliases":["src_second"],"handles":[second_handle]});
        assert_eq!(request_for_plugin(&grants,&BTreeMap::new(),&home,"first-app",&ambiguous_list),Err("typed_object_invalid_request"));
        let malformed_handles = json!({"version":1,"operation":"list","objectType":"test.record:v1","schemaVersion":1,
            "handles":[second_handle,second_handle]});
        assert_eq!(request_for_plugin(&grants,&BTreeMap::new(),&home,"first-app",&malformed_handles),Err("invalid_page"));

        let full_list = json!({"version":1,"operation":"list","objectType":"test.record:v1","schemaVersion":1,"limit":2});
        let full_page = request_for_plugin(&grants,&BTreeMap::new(),&home,"first-app",&full_list).unwrap();
        let ordered = full_page["page"]["objects"].as_array().unwrap();
        assert_eq!(ordered.len(),2);
        let first_handle = ordered[0]["handle"].as_str().unwrap();
        let next_handle = ordered[1]["handle"].as_str().unwrap();
        let after_cursor = json!({"version":1,"operation":"list","objectType":"test.record:v1","schemaVersion":1,
            "afterCursor":first_handle,"limit":1});
        let page = request_for_plugin(&grants,&BTreeMap::new(),&home,"first-app",&after_cursor).unwrap();
        assert_eq!(page["page"]["objects"][0]["handle"],next_handle);
        let legacy_cursor = json!({"version":1,"operation":"list","objectType":"test.record:v1","schemaVersion":1,
            "cursor":first_handle,"limit":1});
        assert_eq!(request_for_plugin(&grants,&BTreeMap::new(),&home,"first-app",&legacy_cursor),Err("typed_object_invalid_request"));

        let _ = std::fs::remove_dir_all(home);
    }
}
