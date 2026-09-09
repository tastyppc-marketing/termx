use std::fmt::Write as _;
use std::io::{self, Write};

use termx_swarm_mcp_protocol::{
    plan_result, plan_tool_result, validate_json, IdView, OutputPlanError, RequestId, ResponseLine,
    MAX_ID_BYTES, MAX_JSON_INPUT_BYTES, MAX_JSON_NODES, MAX_RESPONSE_LINE_BYTES,
    MAX_RESPONSE_WRAPPER_BYTES, OUTPUT_CHUNK_BYTES, OUTPUT_FIXED_SCRATCH_BYTES,
    OUTPUT_MAX_FIXED_WIRE_BYTES,
};

#[test]
fn ordinary_result_is_correlated_and_exactly_counted() {
    let id = RequestId::parse_json_token(b"9007199254740993").unwrap();
    let document = r#"{"messages":[1,2,3],"cursor":"next"}"#;
    let json = validate_json(document.as_bytes()).unwrap();
    let response = plan_result(&id, json).unwrap();

    let mut bytes = Vec::new();
    response.write_to(&mut bytes).unwrap();

    assert_eq!(response.encoded_len(), bytes.len());
    assert_eq!(bytes.last(), Some(&b'\n'));
    assert_eq!(bytes.iter().filter(|&&byte| byte == b'\n').count(), 1);
    let value: serde_json::Value = serde_json::from_slice(&bytes[..bytes.len() - 1]).unwrap();
    assert_eq!(value["jsonrpc"], "2.0");
    assert_eq!(value["id"].as_i64(), Some(9_007_199_254_740_993));
    assert_eq!(
        value["result"],
        serde_json::from_str::<serde_json::Value>(document).unwrap()
    );
}

#[test]
fn tool_result_reuses_the_exact_document_as_structured_and_text_json() {
    let id = RequestId::parse_json_token("\"quoted\\\\id\\n你\"".as_bytes()).unwrap();
    let document = " \t{\"quote\":\"\\\"\",\"slash\":\"\\\\\",\"newline\":\"\\n\",\"cr\":\"\\r\",\"nul\":\"\\u0000\",\"unicode\":\"é你𝄞\",\"surrogate\":\"\\uD834\\uDD1E\",\"records\":[1,2,3],\"cursor\":\"c\\\\\\\"\"}\t ";
    let expected_document: serde_json::Value = serde_json::from_str(document).unwrap();
    let json = validate_json(document.as_bytes()).unwrap();
    let response = plan_tool_result(&id, json, true).unwrap();

    let mut bytes = Vec::new();
    response.write_to(&mut bytes).unwrap();

    assert_eq!(response.encoded_len(), bytes.len());
    assert_eq!(bytes.last(), Some(&b'\n'));
    let value: serde_json::Value = serde_json::from_slice(&bytes[..bytes.len() - 1]).unwrap();
    assert_eq!(value["id"], "quoted\\id\n你");
    assert_eq!(value["result"]["isError"], true);
    assert_eq!(value["result"]["structuredContent"], expected_document);
    assert_eq!(value["result"]["content"].as_array().unwrap().len(), 1);
    let text = value["result"]["content"][0]["text"].as_str().unwrap();
    assert_eq!(text, document);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(text).unwrap(),
        expected_document
    );
}

fn render(response: &ResponseLine<'_>) -> Vec<u8> {
    let mut bytes = Vec::new();
    response.write_to(&mut bytes).unwrap();
    assert_eq!(bytes.len(), response.encoded_len());
    bytes
}

#[test]
fn all_normalized_id_forms_are_emitted_as_the_exact_typed_value() {
    let document = validate_json(br#"{"ok":true}"#).unwrap();
    for (token, expected) in [
        ("-9223372036854775808", i64::MIN),
        ("9223372036854775807", i64::MAX),
        ("9007199254740993", 9_007_199_254_740_993),
        ("1", 1),
        ("1.0", 1),
        ("1e0", 1),
    ] {
        let id = RequestId::parse_json_token(token.as_bytes()).unwrap();
        let bytes = render(&plan_result(&id, document).unwrap());
        let value: serde_json::Value = serde_json::from_slice(&bytes[..bytes.len() - 1]).unwrap();
        assert_eq!(value["id"].as_i64(), Some(expected), "token {token}");
    }

    let mut decoded = "quote\" slash\\ controls\n\r\t unicode-é你𝄞 ".to_owned();
    let initial_len = serde_json::to_string(&decoded).unwrap().len();
    decoded.extend(std::iter::repeat_n('x', MAX_ID_BYTES - initial_len));
    let token = serde_json::to_string(&decoded).unwrap();
    assert_eq!(token.len(), MAX_ID_BYTES);
    let id = RequestId::parse_json_token(token.as_bytes()).unwrap();
    let bytes = render(&plan_result(&id, document).unwrap());
    let value: serde_json::Value = serde_json::from_slice(&bytes[..bytes.len() - 1]).unwrap();
    assert_eq!(value["id"].as_str(), Some(decoded.as_str()));
}

#[derive(Default)]
struct ProbeSink {
    calls: usize,
    bytes: usize,
}

impl Write for ProbeSink {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.calls += 1;
        self.bytes += bytes.len();
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[test]
fn non_objects_and_literal_line_breaks_fail_before_any_sink_call() {
    let id = RequestId::parse_json_token(b"1").unwrap();
    for source in ["[]", "null", "1", "\"text\""] {
        let mut sink = ProbeSink::default();
        let result = plan_result(&id, validate_json(source.as_bytes()).unwrap());
        match result {
            Err(error) => assert_eq!(error, OutputPlanError::ResultObjectRequired),
            Ok(response) => {
                response.write_to(&mut sink).unwrap();
                panic!("non-object result was accepted");
            }
        }
        assert_eq!((sink.calls, sink.bytes), (0, 0));
    }

    for source in ["\n{\"x\":1}", "{\n\"x\":1}", "{\"x\":1}\r"] {
        let mut sink = ProbeSink::default();
        let result = plan_tool_result(&id, validate_json(source.as_bytes()).unwrap(), false);
        match result {
            Err(error) => assert_eq!(error, OutputPlanError::LineBreak),
            Ok(response) => {
                response.write_to(&mut sink).unwrap();
                panic!("literal line break was accepted");
            }
        }
        assert_eq!((sink.calls, sink.bytes), (0, 0));
    }

    let escaped = validate_json(br#"{"line":"one\ntwo\rthree"}"#).unwrap();
    assert!(plan_tool_result(&id, escaped, false).is_ok());
}

struct ChoppySink {
    bytes: Vec<u8>,
    max_write: usize,
    interruptions: usize,
}

impl Write for ChoppySink {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.interruptions != 0 {
            self.interruptions -= 1;
            return Err(io::Error::from(io::ErrorKind::Interrupted));
        }
        let written = bytes.len().min(self.max_write);
        self.bytes.extend_from_slice(&bytes[..written]);
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct FailAfter {
    bytes: Vec<u8>,
    remaining: usize,
}

impl Write for FailAfter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.remaining == 0 {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "synthetic failure",
            ));
        }
        let written = bytes.len().min(self.remaining);
        self.bytes.extend_from_slice(&bytes[..written]);
        self.remaining -= written;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct ZeroSink;

impl Write for ZeroSink {
    fn write(&mut self, _bytes: &[u8]) -> io::Result<usize> {
        Ok(0)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[test]
fn short_interrupted_zero_and_partial_failure_have_exact_write_semantics() {
    let id = RequestId::parse_json_token(b"-9223372036854775808").unwrap();
    let source = format!(r#"{{"payload":"{}"}}"#, r#"x\\\"\t"#.repeat(5_000));
    let document = validate_json(source.as_bytes()).unwrap();
    let response = plan_tool_result(&id, document, false).unwrap();
    let expected = render(&response);

    let mut choppy = ChoppySink {
        bytes: Vec::new(),
        max_write: 3,
        interruptions: 2,
    };
    response.write_to(&mut choppy).unwrap();
    assert_eq!(choppy.bytes, expected);

    let mut zero = ZeroSink;
    assert_eq!(
        response.write_to(&mut zero).unwrap_err().kind(),
        io::ErrorKind::WriteZero
    );

    let failure_point = OUTPUT_CHUNK_BYTES + 137;
    let mut failing = FailAfter {
        bytes: Vec::new(),
        remaining: failure_point,
    };
    assert_eq!(
        response.write_to(&mut failing).unwrap_err().kind(),
        io::ErrorKind::BrokenPipe
    );
    assert_eq!(failing.bytes, expected[..failure_point]);
    assert!(!failing.bytes.ends_with(b"\n"));
}

struct CountingSink {
    calls: usize,
    bytes: usize,
    largest_write: usize,
}

impl Write for CountingSink {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.calls += 1;
        self.bytes += bytes.len();
        self.largest_write = self.largest_write.max(bytes.len());
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn encoded_id_len(id: &RequestId) -> usize {
    match id.view() {
        IdView::Integer(value) => value.to_string().len(),
        IdView::String(value) => serde_json::to_string(value).unwrap().len(),
    }
}

fn oracle_tool_len(id: &RequestId, document: &str, is_error: bool) -> usize {
    br#"{"jsonrpc":"2.0","id":"#.len()
        + encoded_id_len(id)
        + br#","result":{"content":[{"type":"text","text":"#.len()
        + serde_json::to_string(document).unwrap().len()
        + br#"}],"structuredContent":"#.len()
        + document.len()
        + br#","isError":"#.len()
        + if is_error { 4 } else { 5 }
        + b"}}\n".len()
}

fn boundary_document(id: &RequestId) -> (String, usize, String) {
    let prefix = r#"{"padding":""#;
    let suffix = r#""}"#;
    let empty = format!("{prefix}{suffix}");
    let empty_len = oracle_tool_len(id, &empty, false);
    let mut payload_len = (MAX_RESPONSE_LINE_BYTES - empty_len) / 2;
    let mut deficit = MAX_RESPONSE_LINE_BYTES - (empty_len + 2 * payload_len);
    if deficit == 1 {
        payload_len -= 1;
        deficit += 2;
    }
    let mut outer = String::new();
    if deficit % 2 == 1 {
        outer.push('\t');
        deficit -= 3;
    }
    outer.extend(std::iter::repeat_n(' ', deficit / 2));
    let mut document =
        String::with_capacity(prefix.len() + payload_len + suffix.len() + outer.len());
    document.push_str(prefix);
    document.extend(std::iter::repeat_n('a', payload_len));
    document.push_str(suffix);
    document.push_str(&outer);
    (document, payload_len, outer)
}

#[test]
fn exact_32_mib_boundary_succeeds_and_one_byte_over_writes_nothing() {
    let id = RequestId::parse_json_token(b"1").unwrap();
    let (document, payload_len, outer) = boundary_document(&id);
    assert!(document.len() <= MAX_JSON_INPUT_BYTES);
    assert_eq!(
        oracle_tool_len(&id, &document, false),
        MAX_RESPONSE_LINE_BYTES
    );
    let validated = validate_json(document.as_bytes()).unwrap();
    let response = plan_tool_result(&id, validated, false).unwrap();
    assert_eq!(response.encoded_len(), MAX_RESPONSE_LINE_BYTES);
    let mut sink = CountingSink {
        calls: 0,
        bytes: 0,
        largest_write: 0,
    };
    response.write_to(&mut sink).unwrap();
    assert_eq!(sink.bytes, MAX_RESPONSE_LINE_BYTES);
    assert!(sink.largest_write <= OUTPUT_CHUNK_BYTES);
    assert!(sink.calls <= MAX_RESPONSE_LINE_BYTES.div_ceil(OUTPUT_CHUNK_BYTES));

    let prefix = r#"{"padding":""#;
    let suffix = r#""}"#;
    let mut over = String::with_capacity(document.len());
    over.push_str(prefix);
    over.extend(std::iter::repeat_n('a', payload_len - 1));
    over.push_str(suffix);
    over.push_str(&outer);
    over.push('\t');
    assert_eq!(
        oracle_tool_len(&id, &over, false),
        MAX_RESPONSE_LINE_BYTES + 1
    );
    let mut untouched = ProbeSink::default();
    let planned = plan_tool_result(&id, validate_json(over.as_bytes()).unwrap(), false);
    match planned {
        Err(error) => assert_eq!(error, OutputPlanError::LineTooLarge),
        Ok(response) => {
            response.write_to(&mut untouched).unwrap();
            panic!("one-byte oversized result was accepted");
        }
    }
    assert_eq!((untouched.calls, untouched.bytes), (0, 0));
}

fn outgoing_page() -> String {
    const MESSAGES: usize = 9;
    const RECIPIENTS: usize = 4_096;
    let detail = "x".repeat(72);
    let mut json = String::with_capacity(8 * 1024 * 1024);
    json.push_str(r#"{"messages":["#);
    for message in 0..MESSAGES {
        if message != 0 {
            json.push(',');
        }
        write!(json, r#"{{"message_id":"m-{message:08}","recipients":["#).unwrap();
        for recipient in 0..RECIPIENTS {
            if recipient != 0 {
                json.push(',');
            }
            write!(
                json,
                r#"{{"agent":"{message:04}-{recipient:04}-0000-0000-000000000000","status":"Pending","attempt":{recipient},"revision":{message},"sent":false,"read":false,"detail":"{detail}"}}"#
            )
            .unwrap();
        }
        json.push_str("]}");
    }
    json.push_str(r#"],"cursor":"next-page-00000001"}"#);
    json
}

#[test]
fn full_outgoing_page_with_4096_recipient_states_round_trips_every_record() {
    let document = outgoing_page();
    assert!((7 * 1024 * 1024..=8 * 1024 * 1024).contains(&document.len()));
    let validated = validate_json(document.as_bytes()).unwrap();
    assert!(validated.stats().work_nodes() > 524_288);
    assert!(validated.stats().work_nodes() <= MAX_JSON_NODES);
    let id = RequestId::parse_json_token(b"9223372036854775807").unwrap();
    let response = plan_tool_result(&id, validated, false).unwrap();

    assert_eq!(response.owned_heap_bytes(), 0);
    assert_eq!(response.fixed_scratch_bytes(), OUTPUT_FIXED_SCRATCH_BYTES);
    assert!(std::hint::black_box(OUTPUT_FIXED_SCRATCH_BYTES) <= 64 * 1024);
    assert!(std::hint::black_box(MAX_RESPONSE_WRAPPER_BYTES) <= 16 * 1024);
    assert!(std::mem::size_of::<ResponseLine<'_>>() < 128);

    let bytes = render(&response);
    let output: serde_json::Value = serde_json::from_slice(&bytes[..bytes.len() - 1]).unwrap();
    assert_eq!(output["id"].as_i64(), Some(i64::MAX));
    assert_eq!(output["result"]["isError"], false);
    assert_eq!(output["result"]["content"][0]["text"], document);
    assert_eq!(
        output["result"]["structuredContent"]["cursor"],
        "next-page-00000001"
    );
    let messages = output["result"]["structuredContent"]["messages"]
        .as_array()
        .unwrap();
    assert_eq!(messages.len(), 9);
    assert!(messages
        .iter()
        .all(|message| { message["recipients"].as_array().unwrap().len() == 4_096 }));
}

fn large_body_page(collection: &str, body_byte: char) -> String {
    const RECORDS: usize = 128;
    const BODY_BYTES: usize = 60 * 1024;
    let body: String = std::iter::repeat_n(body_byte, BODY_BYTES).collect();
    let mut json = String::with_capacity(8 * 1024 * 1024);
    write!(json, "{{\"{collection}\":[").unwrap();
    for record in 0..RECORDS {
        if record != 0 {
            json.push(',');
        }
        write!(
            json,
            r#"{{"id":"record-{record:08}","from":"agent-{record:04}","revision":{record},"body":"{body}"}}"#
        )
        .unwrap();
    }
    json.push_str(r#"],"cursor":"page-cursor-00000001"}"#);
    json
}

#[test]
fn full_mailbox_and_thread_pages_fit_without_a_formatter_payload_copy() {
    let id = RequestId::parse_json_token(b"7").unwrap();
    for (collection, body_byte, tool) in [("mailbox", 'm', false), ("thread", 't', true)] {
        let document = large_body_page(collection, body_byte);
        assert!((7 * 1024 * 1024..=8 * 1024 * 1024).contains(&document.len()));
        let parsed: serde_json::Value = serde_json::from_str(&document).unwrap();
        assert_eq!(parsed[collection].as_array().unwrap().len(), 128);
        assert_eq!(parsed["cursor"], "page-cursor-00000001");
        let validated = validate_json(document.as_bytes()).unwrap();
        let response = if tool {
            plan_tool_result(&id, validated, false).unwrap()
        } else {
            plan_result(&id, validated).unwrap()
        };
        let mut sink = CountingSink {
            calls: 0,
            bytes: 0,
            largest_write: 0,
        };
        response.write_to(&mut sink).unwrap();
        assert_eq!(sink.bytes, response.encoded_len());
        assert!(sink.largest_write <= OUTPUT_CHUNK_BYTES);
        assert_eq!(response.owned_heap_bytes(), 0);
    }
}

#[test]
fn maximum_source_plain_result_and_large_escape_heavy_tool_are_distinct_cases() {
    let id = RequestId::parse_json_token(b"1").unwrap();
    let prefix = r#"{"payload":""#;
    let suffix = r#""}"#;
    let mut maximum = String::with_capacity(MAX_JSON_INPUT_BYTES);
    maximum.push_str(prefix);
    maximum.extend(std::iter::repeat_n(
        'p',
        MAX_JSON_INPUT_BYTES - prefix.len() - suffix.len(),
    ));
    maximum.push_str(suffix);
    assert_eq!(maximum.len(), MAX_JSON_INPUT_BYTES);
    let plain = plan_result(&id, validate_json(maximum.as_bytes()).unwrap()).unwrap();
    assert!(plain.encoded_len() < MAX_RESPONSE_LINE_BYTES);
    let mut plain_sink = CountingSink {
        calls: 0,
        bytes: 0,
        largest_write: 0,
    };
    plain.write_to(&mut plain_sink).unwrap();
    assert_eq!(plain_sink.bytes, plain.encoded_len());

    let escaped_segment = r#"\\\"\n\r\u0000"#;
    let mut escaped = String::with_capacity(4 * 1024 * 1024);
    escaped.push_str(prefix);
    while escaped.len() + escaped_segment.len() + suffix.len() <= 4 * 1024 * 1024 {
        escaped.push_str(escaped_segment);
    }
    escaped.push_str(suffix);
    let tool = plan_tool_result(&id, validate_json(escaped.as_bytes()).unwrap(), false).unwrap();
    assert_eq!(tool.encoded_len(), oracle_tool_len(&id, &escaped, false));
    let mut tool_sink = CountingSink {
        calls: 0,
        bytes: 0,
        largest_write: 0,
    };
    tool.write_to(&mut tool_sink).unwrap();
    assert_eq!(tool_sink.bytes, tool.encoded_len());
    assert!(tool.encoded_len() > 2 * escaped.len());
}

#[test]
fn fixed_wire_and_scratch_accounting_are_explicit_and_bounded() {
    let id = RequestId::parse_json_token(&serde_json::to_vec(&"i".repeat(1_022)).unwrap()).unwrap();
    let document = validate_json(br#"{"ok":true}"#).unwrap();
    let response = plan_tool_result(&id, document, false).unwrap();
    assert_eq!(response.fixed_scratch_bytes(), OUTPUT_FIXED_SCRATCH_BYTES);
    assert_eq!(response.owned_heap_bytes(), 0);
    assert!(std::hint::black_box(OUTPUT_MAX_FIXED_WIRE_BYTES) <= MAX_RESPONSE_WRAPPER_BYTES);
    assert!(std::hint::black_box(OUTPUT_FIXED_SCRATCH_BYTES) <= 64 * 1024);
    assert_eq!(OUTPUT_CHUNK_BYTES, 8 * 1024);
}

#[test]
fn planning_errors_do_not_echo_result_data() {
    let id = RequestId::parse_json_token(b"1").unwrap();
    let secret = validate_json(b"\n{\"credential-secret\":true}").unwrap();
    let error = match plan_result(&id, secret) {
        Err(error) => error,
        Ok(_) => panic!("line break should fail planning"),
    };
    for rendered in [format!("{error}"), format!("{error:?}")] {
        assert!(!rendered.contains("credential-secret"));
    }
}
