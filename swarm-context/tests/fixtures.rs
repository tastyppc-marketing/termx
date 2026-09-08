use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use sha2::{Digest, Sha256};
use termx_swarm_context::{JsonlScanner, ScanItem, UnavailableReason};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn hash(path: &Path) -> String {
    format!("{:x}", Sha256::digest(fs::read(path).unwrap()))
}

#[test]
fn copied_synthetic_fixtures_match_their_frozen_sources_and_catalogs() {
    let root = fixtures();
    let provenance: Value =
        serde_json::from_slice(&fs::read(root.join("fixture-provenance.json")).unwrap()).unwrap();
    for file in provenance["files"].as_array().unwrap() {
        let destination = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join(file["destination"].as_str().unwrap());
        assert_eq!(hash(&destination), file["sha256"].as_str().unwrap());
        assert_eq!(
            fs::metadata(&destination).unwrap().len(),
            file["bytes"].as_u64().unwrap()
        );
    }

    let original = root.join("adversarial/original");
    let catalog: Value =
        serde_json::from_slice(&fs::read(original.join("catalog.json")).unwrap()).unwrap();
    assert_eq!(
        hash(&original.join("catalog.json")),
        provenance["adversarial_catalog_sha256"].as_str().unwrap()
    );
    for section in ["fixtures", "support_documents"] {
        for item in catalog[section].as_array().unwrap() {
            let path = original.join(item["path"].as_str().unwrap());
            assert_eq!(hash(&path), item["sha256"].as_str().unwrap());
            assert_eq!(
                fs::metadata(path).unwrap().len(),
                item["bytes"].as_u64().unwrap()
            );
        }
    }
}

#[test]
fn derived_oracle_removes_exactly_the_two_argument_summaries() {
    let root = fixtures().join("adversarial");
    let manifest: Value = serde_json::from_slice(
        &fs::read(root.join("derived/summary-delta-manifest.json")).unwrap(),
    )
    .unwrap();
    let changes = manifest["changes"].as_array().unwrap();
    assert_eq!(changes.len(), 2);
    let mut observed = BTreeMap::new();

    for change in changes {
        let original_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join(change["original"].as_str().unwrap());
        let derived_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join(change["derived"].as_str().unwrap());
        assert_eq!(
            hash(&original_path),
            change["original_sha256"].as_str().unwrap()
        );
        assert_eq!(
            hash(&derived_path),
            change["derived_sha256"].as_str().unwrap()
        );
        let mut original: Value =
            serde_json::from_slice(&fs::read(original_path).unwrap()).unwrap();
        let derived: Value = serde_json::from_slice(&fs::read(derived_path).unwrap()).unwrap();
        let pointers = change["removed_json_pointers"].as_array().unwrap();
        assert_eq!(pointers.len(), 1);
        let pointer = pointers[0].as_str().unwrap();
        let parent_pointer = pointer.strip_suffix("/summary").unwrap();
        let removed = original
            .pointer_mut(parent_pointer)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove("summary")
            .unwrap();
        assert_eq!(original, derived, "only summary may differ for {pointer}");
        observed.insert(change["provider"].as_str().unwrap(), removed);
    }

    assert_eq!(observed["claude"], "SYNTHETIC_SAFE_QUERY");
    assert_eq!(observed["codex"], "SYNTHETIC_SAFE_TARGET");
}

#[test]
fn sanitized_structural_jsonl_is_actuated_only_as_a_shape_fixture() {
    let root = fixtures().join("structural/original");
    for (name, expected_records) in [("claude.jsonl", 88), ("codex.jsonl", 71)] {
        let bytes = fs::read(root.join(name)).unwrap();
        let mut scanner = JsonlScanner::new(0);
        let mut records = 0usize;
        scanner
            .push_chunk(&bytes, |item| {
                assert!(
                    matches!(item, ScanItem::Complete(_)),
                    "{name} has invalid JSONL"
                );
                records += 1;
            })
            .unwrap();
        assert!(scanner.lag().is_none());
        assert_eq!(records, expected_records);
    }
}

#[test]
fn retained_byte_edge_fixtures_match_ranges_hashes_reasons_and_lag() {
    let root = fixtures().join("adversarial/original");
    let expected: Value = serde_json::from_slice(
        &fs::read(root.join("expected/byte-edge-cases.expected.json")).unwrap(),
    )
    .unwrap();
    for case in expected["byte_cases"].as_array().unwrap() {
        let bytes = fs::read(root.join(case["fixture_path"].as_str().unwrap())).unwrap();
        let mut scanner = JsonlScanner::new(0);
        let mut items = Vec::new();
        scanner.push_chunk(&bytes, |item| items.push(item)).unwrap();
        let ranges = case["preserved_ranges"].as_array().unwrap();
        let complete_ranges: Vec<_> = ranges
            .iter()
            .filter(|range| range["classification"] != "incomplete_final_append")
            .collect();
        assert_eq!(items.len(), complete_ranges.len());
        for (item, expected_range) in items.iter().zip(complete_ranges) {
            assert_eq!(
                item.range().start().get(),
                expected_range["start"].as_u64().unwrap()
            );
            assert_eq!(
                item.range().end().get(),
                expected_range["end"].as_u64().unwrap()
            );
            assert_eq!(
                item.range().sha256(),
                expected_range["sha256"].as_str().unwrap()
            );
            match expected_range["classification"].as_str().unwrap() {
                "complete_projected" => assert!(matches!(item, ScanItem::Complete(_))),
                "invalid_utf8_unavailable" => assert_eq!(
                    item.unavailable_reason(),
                    Some(UnavailableReason::InvalidUtf8)
                ),
                "malformed_json_unavailable" => assert_eq!(
                    item.unavailable_reason(),
                    Some(UnavailableReason::MalformedJson)
                ),
                other => panic!("unknown fixture classification {other}"),
            }
        }
        match case.get("lag").filter(|value| !value.is_null()) {
            Some(expected_lag) => {
                let lag = scanner.lag().unwrap();
                assert_eq!(
                    lag.captured_through().get(),
                    expected_lag["captured_through"].as_u64().unwrap()
                );
                assert_eq!(
                    lag.observed_length().get(),
                    expected_lag["observed_length"].as_u64().unwrap()
                );
                assert_eq!(
                    lag.pending_bytes(),
                    expected_lag["pending_bytes"].as_u64().unwrap()
                );
            }
            None => assert!(scanner.lag().is_none()),
        }
    }
}
