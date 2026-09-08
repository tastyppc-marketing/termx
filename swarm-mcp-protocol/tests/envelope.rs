use termx_swarm_mcp_protocol::{
    EnvelopeErrorKind, IdView, McpEnvelope, MAX_MCP_INPUT_BYTES, MAX_MCP_METHOD_BYTES,
};

#[test]
fn notification_and_request_ids_remain_distinct_and_exact() {
    let notification = McpEnvelope::parse(br#"{"jsonrpc":"2.0","method":"ping"}"#).unwrap();
    assert!(notification.is_notification());
    assert!(notification.id().is_none());

    let null = McpEnvelope::parse(br#"{"jsonrpc":"2.0","method":"ping","id":null}"#).unwrap_err();
    assert_eq!(null.kind(), EnvelopeErrorKind::InvalidId);

    let exact =
        McpEnvelope::parse(br#"{"jsonrpc":"2.0","method":"unknown/future","id":9007199254740993}"#)
            .unwrap();
    assert_eq!(exact.method(), "unknown/future");
    assert_eq!(
        exact.id().unwrap().view(),
        IdView::Integer(9_007_199_254_740_993)
    );
    assert!(!exact.is_notification());

    let one = McpEnvelope::parse(br#"{"jsonrpc":"2.0","method":"x","id":1}"#).unwrap();
    let one_decimal = McpEnvelope::parse(br#"{"jsonrpc":"2.0","method":"x","id":1.0}"#).unwrap();
    let one_exponent = McpEnvelope::parse(br#"{"jsonrpc":"2.0","method":"x","id":1e0}"#).unwrap();
    assert_eq!(one.id(), one_decimal.id());
    assert_eq!(one.id(), one_exponent.id());
}

#[test]
fn params_is_the_exact_borrowed_object_token() {
    let input = br#" { "jsonrpc" : "2.0", "method":"tools/call", "id":"a", "params" : { "x": [1.25, "\n"] } } "#;
    let envelope = McpEnvelope::parse(input).unwrap();
    let params = envelope.params().unwrap();
    assert_eq!(params, r#"{ "x": [1.25, "\n"] }"#);
    let start = input
        .windows(params.len())
        .position(|window| window == params.as_bytes())
        .unwrap();
    assert_eq!(params.as_ptr(), input[start..].as_ptr());
}

#[test]
fn rejects_non_object_outer_unknown_fields_bad_version_and_bad_params() {
    let rejected = [
        (
            br#"[]"#.as_slice(),
            EnvelopeErrorKind::TopLevelObjectRequired,
        ),
        (
            br#"{"jsonrpc":"2.0","method":"x","result":{}}"#,
            EnvelopeErrorKind::UnknownField,
        ),
        (
            br#"{"jsonrpc":"2.0","method":"x","error":{}}"#,
            EnvelopeErrorKind::UnknownField,
        ),
        (
            br#"{"jsonrpc":"2.0","method":"x","extra":1}"#,
            EnvelopeErrorKind::UnknownField,
        ),
        (br#"{"method":"x"}"#, EnvelopeErrorKind::MissingJsonRpc),
        (br#"{"jsonrpc":"2.0"}"#, EnvelopeErrorKind::MissingMethod),
        (
            br#"{"jsonrpc":"2.1","method":"x"}"#,
            EnvelopeErrorKind::InvalidJsonRpc,
        ),
        (
            br#"{"jsonrpc":2.0,"method":"x"}"#,
            EnvelopeErrorKind::InvalidJsonRpc,
        ),
        (
            br#"{"jsonrpc":"2.0","method":null}"#,
            EnvelopeErrorKind::InvalidMethod,
        ),
        (
            br#"{"jsonrpc":"2.0","method":""}"#,
            EnvelopeErrorKind::InvalidMethod,
        ),
        (
            br#"{"jsonrpc":"2.0","method":"x","params":null}"#,
            EnvelopeErrorKind::ParamsObjectRequired,
        ),
        (
            br#"{"jsonrpc":"2.0","method":"x","params":[]}"#,
            EnvelopeErrorKind::ParamsObjectRequired,
        ),
        (
            br#"{"jsonrpc":"2.0","method":"x","params":1}"#,
            EnvelopeErrorKind::ParamsObjectRequired,
        ),
    ];
    for (input, kind) in rejected {
        assert_eq!(McpEnvelope::parse(input).unwrap_err().kind(), kind);
    }
}

#[test]
fn duplicate_aliases_and_invalid_ids_fail_closed() {
    for input in [
        br#"{"jsonrpc":"2.0","method":"x","m\u0065thod":"y"}"#.as_slice(),
        br#"{"jsonrpc":"2.0","method":"x","params":{"a":1,"\u0061":2}}"#,
    ] {
        assert_eq!(
            McpEnvelope::parse(input).unwrap_err().kind(),
            EnvelopeErrorKind::InvalidJson
        );
    }
    for id in ["null", "true", "1.5", "9223372036854775808"] {
        let input = format!(r#"{{"jsonrpc":"2.0","method":"x","id":{id}}}"#);
        assert_eq!(
            McpEnvelope::parse(input.as_bytes()).unwrap_err().kind(),
            EnvelopeErrorKind::InvalidId
        );
    }
    let oversized = format!(
        r#"{{"jsonrpc":"2.0","method":"x","id":{}}}"#,
        "1".repeat(1025)
    );
    assert_eq!(
        McpEnvelope::parse(oversized.as_bytes()).unwrap_err().kind(),
        EnvelopeErrorKind::InvalidId
    );
    let maximum_string_id = format!(
        r#"{{"jsonrpc":"2.0","method":"x","id":"{}"}}"#,
        "i".repeat(1022)
    );
    assert!(McpEnvelope::parse(maximum_string_id.as_bytes()).is_ok());
    let over_string_id = format!(
        r#"{{"jsonrpc":"2.0","method":"x","id":"{}"}}"#,
        "i".repeat(1023)
    );
    assert_eq!(
        McpEnvelope::parse(over_string_id.as_bytes())
            .unwrap_err()
            .kind(),
        EnvelopeErrorKind::InvalidId
    );
}

#[test]
fn line_delimiters_are_stripped_by_the_adapter_and_escaped_newlines_are_valid() {
    for input in [
        b"{\"jsonrpc\":\"2.0\",\n\"method\":\"x\"}".as_slice(),
        b"{\"jsonrpc\":\"2.0\",\"method\":\"x\"}\n",
        b"{\"jsonrpc\":\"2.0\",\"method\":\"x\"}\r\n",
    ] {
        assert_eq!(
            McpEnvelope::parse(input).unwrap_err().kind(),
            EnvelopeErrorKind::LineBreak
        );
    }
    let escaped =
        McpEnvelope::parse(br#"{"jsonrpc":"2.0","method":"x","params":{"text":"line\nnext"}}"#)
            .unwrap();
    assert!(escaped.params().unwrap().contains("\\n"));
}

#[test]
fn decoded_method_and_input_size_boundaries_are_exact() {
    let method = "m".repeat(MAX_MCP_METHOD_BYTES);
    let accepted = format!(r#"{{"jsonrpc":"2.0","method":"{method}"}}"#);
    assert_eq!(
        McpEnvelope::parse(accepted.as_bytes()).unwrap().method(),
        method
    );

    let escaped_method = "\\u006d".repeat(MAX_MCP_METHOD_BYTES);
    let escaped = format!(r#"{{"jsonrpc":"2.0","method":"{escaped_method}"}}"#);
    assert_eq!(
        McpEnvelope::parse(escaped.as_bytes()).unwrap().method(),
        method
    );

    let too_long = format!(
        r#"{{"jsonrpc":"2.0","method":"{}"}}"#,
        "m".repeat(MAX_MCP_METHOD_BYTES + 1)
    );
    assert_eq!(
        McpEnvelope::parse(too_long.as_bytes()).unwrap_err().kind(),
        EnvelopeErrorKind::MethodTooLong
    );
    let unicode_method = "😀".repeat(32);
    let unicode = format!(r#"{{"jsonrpc":"2.0","method":"{unicode_method}"}}"#);
    assert_eq!(
        McpEnvelope::parse(unicode.as_bytes()).unwrap().method(),
        unicode_method
    );
    let unicode_too_long = format!(r#"{{"jsonrpc":"2.0","method":"{}"}}"#, "😀".repeat(33));
    assert_eq!(
        McpEnvelope::parse(unicode_too_long.as_bytes())
            .unwrap_err()
            .kind(),
        EnvelopeErrorKind::MethodTooLong
    );

    let prefix = r#"{"jsonrpc":"2.0","method":"x","params":{"padding":""#;
    let suffix = r#""}}"#;
    let padding = "a".repeat(MAX_MCP_INPUT_BYTES - prefix.len() - suffix.len());
    let maximum = format!("{prefix}{padding}{suffix}");
    assert_eq!(maximum.len(), MAX_MCP_INPUT_BYTES);
    McpEnvelope::parse(maximum.as_bytes()).unwrap();
    let over = format!("{prefix}{padding}a{suffix}");
    assert_eq!(
        McpEnvelope::parse(over.as_bytes()).unwrap_err().kind(),
        EnvelopeErrorKind::InputTooLarge
    );
}

#[test]
fn escaped_version_is_decoded_but_errors_never_echo_envelope_data() {
    let accepted = McpEnvelope::parse(
        br#"{"jsonrpc":"\u0032.0","method":"unknown-secret-method","params":{}}"#,
    )
    .unwrap();
    assert_eq!(accepted.method(), "unknown-secret-method");

    let input = br#"{"jsonrpc":"2.0","method":"credential-secret","forbidden":1}"#;
    let error = McpEnvelope::parse(input).unwrap_err();
    for rendered in [format!("{error}"), format!("{error:?}")] {
        assert!(!rendered.contains("credential-secret"));
        assert!(!rendered.contains("forbidden"));
    }
}
