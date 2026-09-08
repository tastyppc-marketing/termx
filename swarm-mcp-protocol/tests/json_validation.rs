use termx_swarm_mcp_protocol::{
    validate_json, JsonErrorKind, JSON_VALIDATOR_SCRATCH_BYTES, MAX_JSON_DEPTH,
    MAX_JSON_INPUT_BYTES, MAX_JSON_KEYS_PER_OBJECT, MAX_JSON_LIVE_KEYS, MAX_JSON_NODES,
};

fn nested_key_document(levels: usize) -> String {
    let mut json = String::new();
    for level in 0..levels {
        json.push('{');
        for key in 0..63 {
            json.push_str(&format!("\"k{level}_{key}\":null,"));
        }
        json.push_str("\"next\":");
    }
    json.push_str("null");
    for _ in 0..levels {
        json.push('}');
    }
    json
}

fn null_array(values: usize) -> String {
    let mut json = String::with_capacity(values.saturating_mul(5).saturating_add(2));
    json.push('[');
    for index in 0..values {
        if index != 0 {
            json.push(',');
        }
        json.push_str("null");
    }
    json.push(']');
    json
}

#[test]
fn validates_every_json_kind_and_matches_serde_on_diverse_documents() {
    let metadata = "m".repeat(768);
    let generated = (0..8_192)
        .map(|index| {
            format!(
                "{{\"peer_id\":\"p_{index:032x}\",\"group_id\":\"g_{index:032x}\",\"revision\":{},\"ready\":{},\"page_metadata\":\"{metadata}\"}}",
                index + 1,
                index % 2 == 0
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    let documents = [
        "null".to_owned(),
        "true".to_owned(),
        "-0.125e+7".to_owned(),
        "\"plain and \\uD83D\\uDE00\"".to_owned(),
        "[null,false,1,1.25e-3,\"x\",{},[]]".to_owned(),
        "{\"a\":[1,2],\"b\":{\"escaped\\u005fkey\":\"value\"}}".to_owned(),
        format!("[{generated}]"),
    ];
    for document in &documents {
        let validated = validate_json(document.as_bytes()).unwrap();
        assert_eq!(validated.as_str(), document.as_str());
        assert!(serde_json::from_str::<serde_json::Value>(document).is_ok());
        assert!(validated.stats().work_nodes() <= MAX_JSON_NODES);
    }
    let core_page = documents.last().unwrap();
    assert!((7 * 1024 * 1024..=9 * 1024 * 1024).contains(&core_page.len()));
    let core_stats = validate_json(core_page.as_bytes()).unwrap().stats();
    eprintln!(
        "core-shaped page: {} bytes, {} key-plus-value nodes",
        core_page.len(),
        core_stats.work_nodes()
    );
}

#[test]
fn duplicate_keys_use_exact_decoded_unicode_at_every_depth() {
    for duplicate in [
        r#"{"a":1,"\u0061":2}"#,
        r#"{"\uD83D\uDE00":1,"😀":2}"#,
        r#"{"outer":{"x":1,"\u0078":2}}"#,
    ] {
        assert_eq!(
            validate_json(duplicate.as_bytes()).unwrap_err().kind(),
            JsonErrorKind::DuplicateKey
        );
    }
    validate_json(br#"{"left":{"same":1},"right":{"same":2}}"#).unwrap();
}

#[test]
fn rejects_invalid_utf8_escapes_controls_numbers_and_trailing_input() {
    let invalid: &[&[u8]] = &[
        b"",
        b"\xff",
        b"\"unterminated",
        b"\"raw\nline\"",
        br#""\uD800""#,
        br#""\uDC00""#,
        br#""\uD800\u0041""#,
        b"+1",
        b"01",
        b"1.",
        b"1e",
        b"1e+",
        b"--1",
        b"tru",
        b"null false",
        b"[1,]",
        b"{\"a\":1,}",
        b"{\"a\" 1}",
    ];
    for input in invalid {
        assert!(
            validate_json(input).is_err(),
            "accepted invalid synthetic corpus member"
        );
        assert!(serde_json::from_slice::<serde_json::Value>(input).is_err());
    }
    validate_json(br#""\uD83D\uDE00""#).unwrap();
}

#[test]
fn depth_object_key_and_live_key_boundaries_are_exact() {
    let depth_ok = format!(
        "{}null{}",
        "[".repeat(MAX_JSON_DEPTH),
        "]".repeat(MAX_JSON_DEPTH)
    );
    let depth_bad = format!(
        "{}null{}",
        "[".repeat(MAX_JSON_DEPTH + 1),
        "]".repeat(MAX_JSON_DEPTH + 1)
    );
    assert_eq!(
        validate_json(depth_ok.as_bytes())
            .unwrap()
            .stats()
            .max_depth(),
        64
    );
    assert_eq!(
        validate_json(depth_bad.as_bytes()).unwrap_err().kind(),
        JsonErrorKind::DepthLimit
    );

    let object_ok = format!(
        "{{{}}}",
        (0..MAX_JSON_KEYS_PER_OBJECT)
            .map(|key| format!("\"k{key}\":null"))
            .collect::<Vec<_>>()
            .join(",")
    );
    let object_bad = format!(
        "{{{}}}",
        (0..=MAX_JSON_KEYS_PER_OBJECT)
            .map(|key| format!("\"k{key}\":null"))
            .collect::<Vec<_>>()
            .join(",")
    );
    validate_json(object_ok.as_bytes()).unwrap();
    assert_eq!(
        validate_json(object_bad.as_bytes()).unwrap_err().kind(),
        JsonErrorKind::ObjectKeyLimit
    );

    let live_ok = nested_key_document(MAX_JSON_LIVE_KEYS / MAX_JSON_KEYS_PER_OBJECT);
    let live_bad = nested_key_document(MAX_JSON_LIVE_KEYS / MAX_JSON_KEYS_PER_OBJECT + 1);
    assert_eq!(
        validate_json(live_ok.as_bytes())
            .unwrap()
            .stats()
            .max_live_keys(),
        MAX_JSON_LIVE_KEYS
    );
    assert_eq!(
        validate_json(live_bad.as_bytes()).unwrap_err().kind(),
        JsonErrorKind::LiveKeyLimit
    );

    let key_ok = format!("{{\"{}\":0}}", "a".repeat(128));
    let key_bad = format!("{{\"{}\":0}}", "a".repeat(129));
    validate_json(key_ok.as_bytes()).unwrap();
    assert_eq!(
        validate_json(key_bad.as_bytes()).unwrap_err().kind(),
        JsonErrorKind::KeyTooLong
    );
    let unicode_key_ok = format!("{{\"{}\":0}}", "😀".repeat(32));
    let unicode_key_bad = format!("{{\"{}\":0}}", "😀".repeat(33));
    validate_json(unicode_key_ok.as_bytes()).unwrap();
    assert_eq!(
        validate_json(unicode_key_bad.as_bytes())
            .unwrap_err()
            .kind(),
        JsonErrorKind::KeyTooLong
    );
}

#[test]
fn node_work_boundary_counts_keys_and_values() {
    let accepted = null_array(MAX_JSON_NODES - 1);
    let rejected = null_array(MAX_JSON_NODES);
    let stats = validate_json(accepted.as_bytes()).unwrap().stats();
    assert_eq!(stats.work_nodes(), MAX_JSON_NODES);
    assert_eq!(
        validate_json(rejected.as_bytes()).unwrap_err().kind(),
        JsonErrorKind::NodeLimit
    );
}

#[test]
fn maximum_escaped_value_and_large_number_use_fixed_zero_heap_scratch() {
    let mut escaped = String::with_capacity(MAX_JSON_INPUT_BYTES);
    escaped.push('"');
    let mut remaining = MAX_JSON_INPUT_BYTES - 2;
    while remaining >= 6 {
        escaped.push_str("\\u0061");
        remaining -= 6;
    }
    escaped.extend(std::iter::repeat_n('a', remaining));
    escaped.push('"');
    assert_eq!(escaped.len(), MAX_JSON_INPUT_BYTES);
    let validated = validate_json(escaped.as_bytes()).unwrap();
    assert!(validated.stats().scratch_capacity_bytes() <= 64 * 1024);
    eprintln!(
        "fixed JSON scanner scratch: {} bytes; heap scratch: {} bytes",
        JSON_VALIDATOR_SCRATCH_BYTES,
        validated.stats().heap_scratch_bytes()
    );
    assert_eq!(validated.stats().heap_scratch_bytes(), 0);
    assert_eq!(
        validated.stats().scratch_capacity_bytes(),
        JSON_VALIDATOR_SCRATCH_BYTES
    );

    let mut number = String::with_capacity(MAX_JSON_INPUT_BYTES);
    number.push('1');
    number.extend(std::iter::repeat_n('0', MAX_JSON_INPUT_BYTES - 1));
    assert_eq!(number.len(), MAX_JSON_INPUT_BYTES);
    assert_eq!(
        validate_json(number.as_bytes())
            .unwrap()
            .stats()
            .work_nodes(),
        1
    );

    number.push('0');
    assert_eq!(
        validate_json(number.as_bytes()).unwrap_err().kind(),
        JsonErrorKind::InputTooLarge
    );
}

#[test]
fn giant_escaped_key_is_rejected_without_retaining_its_payload() {
    let giant_key = format!("{{\"{}\":0}}", "\\u0061".repeat(1_000_000));
    let error = validate_json(giant_key.as_bytes()).unwrap_err();
    assert_eq!(error.kind(), JsonErrorKind::KeyTooLong);
    let rendered = format!("{error:?}");
    assert!(!rendered.contains("u0061"));
    assert!(rendered.len() < 128);
}

#[test]
fn errors_are_positioned_and_never_echo_sensitive_input() {
    let secret = br#"{"password":"credential-secret","bad":}"#;
    let error = validate_json(secret).unwrap_err();
    assert!(error.offset() < secret.len());
    for rendered in [format!("{error}"), format!("{error:?}")] {
        assert!(!rendered.contains("credential-secret"));
        assert!(!rendered.contains("password"));
    }
}
