use termx_swarm_client::{
    decode_frame, encode_frame, DecimalU64, DiscoveryRecord, Hello, ProcessIdentity,
    RequestEnvelope, WireError, MAX_FRAME_BYTES, WIRE_VERSION,
};

#[test]
fn decimal_is_canonical_string_only() {
    assert_eq!(
        DecimalU64::parse("9007199254740993").unwrap().get(),
        9_007_199_254_740_993
    );
    for invalid in ["", "01", "+1", "-1", " 1", "1 ", "18446744073709551616"] {
        assert!(DecimalU64::parse(invalid).is_err(), "accepted {invalid:?}");
    }
    assert!(serde_json::from_str::<DecimalU64>("1").is_err());
    assert_eq!(
        serde_json::to_string(&DecimalU64::new(42)).unwrap(),
        "\"42\""
    );
}

#[test]
fn discovery_rejects_unbounded_pipe_name_vocabulary() {
    let discovery = DiscoveryRecord::new(
        "authority-1",
        "boot-1",
        ProcessIdentity::new(1, 1),
        "\\\\.\\pipe\\valid-prefix\nspoofed-line",
    );
    assert!(!discovery.validate());
}

#[test]
fn strict_typed_frames_reject_duplicates_unknowns_trailing_and_oversize() {
    let request = RequestEnvelope::hello("correlation-1", Hello::new("boot-1"));
    let encoded = encode_frame(&request).unwrap();
    assert_eq!(decode_frame::<RequestEnvelope>(&encoded).unwrap(), request);
    assert!(matches!(
        encode_frame(&RequestEnvelope::hello("", Hello::new("boot-1"))),
        Err(WireError::InvalidFrame)
    ));
    for json in [
        r#"{"version":1,"version":1,"correlationId":"c","kind":"hello","payload":{"bootId":"b"}}"#,
        r#"{"version":1,"correlationId":"c","kind":"hello","payload":{"bootId":"b"},"extra":1}"#,
        r#"{"version":1,"correlationId":"c","kind":"hello","kind":"hello","payload":{"bootId":"b"}}"#,
        r#"{"version":1,"correlationId":"c","kind":"hello","payload":{"bootId":"b"},"payload":{"bootId":"b"}}"#,
        r#"{"version":1,"correlationId":"c","kind":"hello","payload":{"bootId":"b","extra":1}}"#,
        r#"{"version":1,"correlationId":"c","kind":"other","payload":{"bootId":"b"}}"#,
        r#"{"version":1,"correlationId":"c","kind":"hello","payload":{"bootId":"b"}}x"#,
    ] {
        let mut frame = (json.len() as u32).to_le_bytes().to_vec();
        frame.extend_from_slice(json.as_bytes());
        assert!(decode_frame::<RequestEnvelope>(&frame).is_err());
    }
    assert!(matches!(
        decode_frame::<RequestEnvelope>(&((MAX_FRAME_BYTES as u32 + 1).to_le_bytes())),
        Err(WireError::FrameTooLarge)
    ));
    assert_eq!(WIRE_VERSION, 1);
}
