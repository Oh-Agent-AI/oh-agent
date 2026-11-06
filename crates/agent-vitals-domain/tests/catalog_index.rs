use std::collections::BTreeMap;
use agent_vitals_domain::domain::catalog_index::{local_allowed, parse_catalog, validate_catalog, SlotSupport};
use serde_json::Value;

fn fixture() -> Value { serde_json::from_str(include_str!("../../../fixtures/catalog-index-v1.json")).unwrap() }
fn support() -> BTreeMap<String, SlotSupport> {
    BTreeMap::from([("harness_manifest".into(), SlotSupport { schemas: vec![1], capabilities: vec!["recipe:message".into()] })])
}
#[test]
fn shared_cases() {
    let hash = "c".repeat(64);
    assert_eq!(validate_catalog(&fixture(), &support(), "1.4.0", &hash, None), Ok(()));
    let cases: Value = serde_json::from_str(include_str!("../../../fixtures/catalog-index-invalid-cases.json")).unwrap();
    for case in cases.as_array().unwrap() {
        let mut index = fixture();
        index["entries"][0][case["field"].as_str().unwrap()] = case["value"].clone();
        assert_eq!(validate_catalog(&index, &support(), "1.4.0", &hash, None), Err(case["error"].as_str().unwrap()), "{case}");
    }
}
#[test]
fn dependencies_sequence_permissions() {
    let hash = "c".repeat(64);
    let mut index = fixture();
    assert_eq!(validate_catalog(&index, &support(), "1.4.0", &hash, Some((8, &hash))), Err("sequence_conflict"));
    assert_eq!(validate_catalog(&index, &support(), "1.4.0", &hash, Some((7, &"d".repeat(64)))), Err("sequence_conflict"));
    let entry = &index["entries"][0];
    let dep = serde_json::json!({"slot_type":entry["slot_type"], "slot_id":entry["slot_id"], "revision":entry["revision"], "sha256":entry["sha256"]});
    index["entries"][0]["dependencies"] = serde_json::json!([dep]);
    assert_eq!(validate_catalog(&index, &support(), "1.4.0", &hash, None), Err("dependency_cycle"));
    index["entries"][0]["dependencies"][0]["sha256"] = serde_json::json!("d".repeat(64));
    assert_eq!(validate_catalog(&index, &support(), "1.4.0", &hash, None), Err("dependency_missing"));
    assert!(!local_allowed("subscription_scope"));
    assert!(local_allowed("harness_manifest"));
}
#[test]
fn timestamps_and_dependency_diamond() {
    let hash = "c".repeat(64);
    let cases: Value = serde_json::from_str(include_str!("../../../fixtures/catalog-index-timestamps.json")).unwrap();
    for case in cases.as_array().unwrap() {
        let mut index = fixture();
        index["published_at"] = case["value"].clone();
        assert_eq!(validate_catalog(&index, &support(), "1.4.0", &hash, None), if case["valid"] == true { Ok(()) } else { Err("published_at") });
    }
    let mut index = fixture();
    let template = index["entries"][0].clone();
    let entries: Vec<_> = ["a", "b", "c", "d"].iter().map(|id| { let mut e = template.clone(); e["slot_id"] = serde_json::json!(id); e }).collect();
    index["entries"] = serde_json::json!(entries);
    let dep = |id: &str| serde_json::json!({"slot_type":"harness_manifest", "slot_id":id, "revision":template["revision"], "sha256":template["sha256"]});
    index["entries"][0]["dependencies"] = serde_json::json!([dep("b"), dep("c")]);
    index["entries"][1]["dependencies"] = serde_json::json!([dep("d")]);
    index["entries"][2]["dependencies"] = serde_json::json!([dep("d")]);
    assert_eq!(validate_catalog(&index, &support(), "1.4.0", &hash, None), Ok(()));
    index["entries"][3]["dependencies"] = serde_json::json!([dep("b")]);
    assert_eq!(validate_catalog(&index, &support(), "1.4.0", &hash, None), Err("dependency_cycle"));
    index["entries"][3]["dependencies"] = serde_json::json!([]);
    index["entries"][0]["dependencies"] = serde_json::json!([dep("b"), dep("b")]);
    assert_eq!(validate_catalog(&index, &support(), "1.4.0", &hash, None), Err("dependency_duplicate"));
    index["entries"][0]["dependencies"] = serde_json::json!([dep("absent")]);
    assert_eq!(validate_catalog(&index, &support(), "1.4.0", &hash, None), Err("dependency_missing"));
}
#[test]
fn parser_limits_and_huge_version() {
    for bytes in [b"NaN".as_slice(), b"Infinity".as_slice(), b"{".as_slice()] {
        assert_eq!(parse_catalog(bytes), Err("index_json"));
    }
    assert_eq!(parse_catalog(&vec![b'x'; 4 * 1024 * 1024 + 1]), Err("index_bytes_limit"));
    let mut index = fixture();
    index["entries"][0]["min_app_version"] = serde_json::json!(format!("{}.0.0", "9".repeat(5000)));
    assert_eq!(validate_catalog(&index, &support(), "1.4.0", &"c".repeat(64), None), Err("version"));
}
