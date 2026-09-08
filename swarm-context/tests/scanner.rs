use sha2::{Digest, Sha256};
use termx_swarm_context::{
    JsonlScanner, ScanError, ScanItem, UnavailableReason, MAX_JSON_DEPTH, MAX_OBJECT_MEMBERS,
    MAX_RECORD_BYTES, MAX_VALUE_NODES,
};

fn json_line_with_total_bytes(total: usize, crlf: bool) -> Vec<u8> {
    let ending = if crlf { "\r\n" } else { "\n" };
    let fixed = format!(r#"{{"pad":""}}{ending}"#);
    assert!(total >= fixed.len());
    format!(r#"{{"pad":"{}"}}{ending}"#, "x".repeat(total - fixed.len())).into_bytes()
}

fn scan(chunks: &[&[u8]]) -> (JsonlScanner, Vec<ScanItem>) {
    let mut scanner = JsonlScanner::new(17);
    let mut items = Vec::new();
    for chunk in chunks {
        scanner
            .push_chunk(chunk, |item| items.push(item))
            .expect("bounded input offsets");
    }
    (scanner, items)
}

#[test]
fn complete_record_limit_includes_lf_and_crlf() {
    assert_eq!(MAX_RECORD_BYTES, 1024 * 1024);
    for crlf in [false, true] {
        let exact = json_line_with_total_bytes(MAX_RECORD_BYTES, crlf);
        let (_, exact_items) = scan(&[&exact]);
        assert_eq!(exact_items.len(), 1);
        assert!(matches!(exact_items[0], ScanItem::Complete(_)));
        assert_eq!(exact_items[0].range().start().get(), 17);
        assert_eq!(
            exact_items[0].range().end().get(),
            17 + MAX_RECORD_BYTES as u64
        );

        let over = json_line_with_total_bytes(MAX_RECORD_BYTES + 1, crlf);
        let (_, over_items) = scan(&[&over]);
        assert_eq!(over_items.len(), 1);
        assert_eq!(
            over_items[0].unavailable_reason(),
            Some(UnavailableReason::RecordTooLarge)
        );
    }
}

#[test]
fn invalid_utf8_malformed_json_and_duplicate_decoded_keys_do_not_hide_later_lines() {
    let bytes = b"{\"ok\":1}\n{\"bad\":\xff}\n{broken}\n{\"a\":1,\"\\u0061\":2}\n{\"later\":2}\n";
    let (_, items) = scan(&[bytes]);
    assert_eq!(items.len(), 5);
    assert!(matches!(items[0], ScanItem::Complete(_)));
    assert_eq!(
        items[1].unavailable_reason(),
        Some(UnavailableReason::InvalidUtf8)
    );
    assert_eq!(
        items[2].unavailable_reason(),
        Some(UnavailableReason::MalformedJson)
    );
    assert_eq!(
        items[3].unavailable_reason(),
        Some(UnavailableReason::MalformedJson)
    );
    assert!(matches!(items[4], ScanItem::Complete(_)));
}

fn nested_object(array_depth: usize) -> Vec<u8> {
    let mut value = String::from(r#"{"value":"#);
    value.push_str(&"[".repeat(array_depth));
    value.push('0');
    value.push_str(&"]".repeat(array_depth));
    value.push_str("}\n");
    value.into_bytes()
}

#[test]
fn depth_is_counted_as_nested_containers_with_root_object_at_one() {
    assert_eq!(MAX_JSON_DEPTH, 64);
    let at_limit = nested_object(MAX_JSON_DEPTH - 1);
    let over_limit = nested_object(MAX_JSON_DEPTH);
    let (_, items) = scan(&[&at_limit, &over_limit, b"{\"later\":true}\n"]);
    assert!(matches!(items[0], ScanItem::Complete(_)));
    assert_eq!(
        items[1].unavailable_reason(),
        Some(UnavailableReason::NestingTooDeep)
    );
    assert!(matches!(items[2], ScanItem::Complete(_)));
}

fn object_with_members(count: usize) -> Vec<u8> {
    let mut value = String::from("{");
    for index in 0..count {
        if index > 0 {
            value.push(',');
        }
        value.push_str(&format!(r#""k{index}":0"#));
    }
    value.push_str("}\n");
    value.into_bytes()
}

fn object_with_array_values(count: usize) -> Vec<u8> {
    let mut value = String::from(r#"{"v":["#);
    for index in 0..count {
        if index > 0 {
            value.push(',');
        }
        value.push('0');
    }
    value.push_str("]}\n");
    value.into_bytes()
}

#[test]
fn member_and_value_node_limits_are_global_per_record() {
    assert_eq!(MAX_OBJECT_MEMBERS, 16_384);
    assert_eq!(MAX_VALUE_NODES, 65_536);

    let members_at_limit = object_with_members(MAX_OBJECT_MEMBERS);
    let members_over = object_with_members(MAX_OBJECT_MEMBERS + 1);
    let (_, member_items) = scan(&[&members_at_limit, &members_over]);
    assert!(matches!(member_items[0], ScanItem::Complete(_)));
    assert_eq!(
        member_items[1].unavailable_reason(),
        Some(UnavailableReason::ResourceLimit)
    );

    // Root object + array + scalar elements are all value nodes.
    let nodes_at_limit = object_with_array_values(MAX_VALUE_NODES - 2);
    let nodes_over = object_with_array_values(MAX_VALUE_NODES - 1);
    let (_, node_items) = scan(&[&nodes_at_limit, &nodes_over]);
    assert!(matches!(node_items[0], ScanItem::Complete(_)));
    assert_eq!(
        node_items[1].unavailable_reason(),
        Some(UnavailableReason::ResourceLimit)
    );

    let left = object_with_members(MAX_OBJECT_MEMBERS / 2);
    let right = object_with_members(MAX_OBJECT_MEMBERS / 2 + 1);
    let left = std::str::from_utf8(&left[..left.len() - 1]).unwrap();
    let right = std::str::from_utf8(&right[..right.len() - 1]).unwrap();
    let nested = format!("{{\"left\":{left},\"right\":{right}}}\n");
    let (_, nested_items) = scan(&[nested.as_bytes()]);
    assert_eq!(
        nested_items[0].unavailable_reason(),
        Some(UnavailableReason::ResourceLimit),
        "member cap is global across nested objects"
    );
}

#[test]
fn chunk_partitioning_preserves_utf8_crlf_ranges_hashes_and_results() {
    let bytes = "{\"text\":\"hé\"}\r\n{\"next\":true}\n".as_bytes();
    let (_, whole) = scan(&[bytes]);
    let byte_chunks: Vec<&[u8]> = bytes.chunks(1).collect();
    let (_, split) = scan(&byte_chunks);
    assert_eq!(split, whole);
}

#[test]
fn overlong_pending_record_uses_bounded_storage_then_recovers_after_lf() {
    let prefix = vec![b'x'; MAX_RECORD_BYTES * 3];
    let (mut scanner, mut items) = scan(&[&prefix]);
    let lag = scanner.lag().expect("unterminated span");
    assert_eq!(lag.pending_bytes(), (MAX_RECORD_BYTES * 3) as u64);
    assert!(lag.retained_bytes() <= MAX_RECORD_BYTES);
    assert!(lag.oversized());
    assert_eq!(lag.sha256(), format!("{:x}", Sha256::digest(&prefix)));

    scanner
        .push_chunk(b"\n{\"recovered\":true}\n", |item| items.push(item))
        .unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(
        items[0].unavailable_reason(),
        Some(UnavailableReason::RecordTooLarge)
    );
    assert!(matches!(items[1], ScanItem::Complete(_)));
    assert!(scanner.lag().is_none());
}

#[test]
fn pending_vector_capacity_is_bounded_for_uneven_chunk_growth() {
    let mut scanner = JsonlScanner::new(0);
    scanner.push_chunk(&vec![b'x'; 600_000], |_| {}).unwrap();
    scanner.push_chunk(&vec![b'x'; 448_576], |_| {}).unwrap();
    let lag = scanner.lag().unwrap();
    assert_eq!(lag.retained_bytes(), MAX_RECORD_BYTES);
    assert!(lag.retained_capacity() <= MAX_RECORD_BYTES);
}

#[test]
fn offset_overflow_rejects_the_chunk_without_consuming_state() {
    let mut scanner = JsonlScanner::new(u64::MAX - 1);
    let before = scanner.lag();
    let error = scanner.push_chunk(b"{}", |_| {}).unwrap_err();
    assert_eq!(error, ScanError::OffsetOverflow);
    assert_eq!(scanner.lag(), before);
}
