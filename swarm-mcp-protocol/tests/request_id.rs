use std::collections::HashSet;
use std::hash::{Hash, Hasher};

use termx_swarm_mcp_protocol::{IdError, IdView, RequestId, MAX_ID_BYTES};

fn parse(raw: &[u8]) -> RequestId {
    RequestId::parse_json_token(raw)
        .unwrap_or_else(|err| panic!("expected {raw:?} to parse, got {err:?}"))
}

fn hash_of(id: &RequestId) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    id.hash(&mut hasher);
    hasher.finish()
}

#[test]
fn numeric_integral_spellings_collide_and_string_one_is_distinct() {
    let integer = parse(b"1");
    let dotted = parse(b"1.0");
    let exp = parse(b"1e0");
    let scaled = parse(b"10e-1");
    let plus_exp = parse(b"1E+0");
    let zero = parse(b"0");
    let minus_zero = parse(b"-0");
    let minus_zero_dot = parse(b"-0.0");
    let string_one = parse(br#""1""#);

    assert_eq!(integer, dotted);
    assert_eq!(integer, exp);
    assert_eq!(integer, scaled);
    assert_eq!(integer, plus_exp);
    assert_eq!(zero, minus_zero);
    assert_eq!(zero, minus_zero_dot);
    assert_ne!(integer, string_one);
    assert_eq!(integer.view(), IdView::Integer(1));
    assert_eq!(string_one.view(), IdView::String("1"));
    assert_eq!(hash_of(&integer), hash_of(&dotted));
    assert_eq!(hash_of(&zero), hash_of(&minus_zero));
    assert_ne!(hash_of(&integer), hash_of(&string_one));

    let mut set = HashSet::new();
    set.insert(integer.clone());
    set.insert(dotted);
    set.insert(string_one.clone());
    assert_eq!(set.len(), 2);
    assert!(set.contains(&exp));
    assert!(set.contains(&string_one));
}

#[test]
fn additional_integral_normalizations_are_exact() {
    assert_eq!(parse(b"1.2300e2").view(), IdView::Integer(123));
    assert_eq!(parse(b"100.0e-2").view(), IdView::Integer(1));
    assert_eq!(parse(b"10.0e-1").view(), IdView::Integer(1));
    assert_eq!(parse(b"0.0").view(), IdView::Integer(0));
    assert_eq!(parse(b"0e0").view(), IdView::Integer(0));
    assert_eq!(parse(b"-1").view(), IdView::Integer(-1));
    assert_eq!(parse(b"-1.0e0").view(), IdView::Integer(-1));
}

#[test]
fn signed_i64_endpoints_and_two_pow_53_plus_one_round_trip_exactly() {
    let max = parse(b"9223372036854775807");
    let min = parse(b"-9223372036854775808");
    let above_float = parse(b"9007199254740993");
    assert_eq!(max.view(), IdView::Integer(i64::MAX));
    assert_eq!(min.view(), IdView::Integer(i64::MIN));
    assert_eq!(above_float.view(), IdView::Integer(9_007_199_254_740_993));
    assert_eq!(max.encoded_len(), i64::MAX.to_string().len());
    assert_eq!(min.encoded_len(), i64::MIN.to_string().len());
    assert!(min.encoded_len() <= 20);
    assert_eq!(
        parse(b"9223372036854775807.0").view(),
        IdView::Integer(i64::MAX)
    );
    assert_eq!(
        parse(b"9007199254740993.0").view(),
        IdView::Integer(9_007_199_254_740_993)
    );
}

#[test]
fn just_outside_signed_i64_rejects() {
    assert_eq!(
        RequestId::parse_json_token(b"9223372036854775808"),
        Err(IdError::OutOfRange)
    );
    assert_eq!(
        RequestId::parse_json_token(b"-9223372036854775809"),
        Err(IdError::OutOfRange)
    );
    assert_eq!(
        RequestId::parse_json_token(b"9223372036854775807.1"),
        Err(IdError::NonIntegral)
    );
}

#[test]
fn numeric_syntax_rejects_without_unbounded_work() {
    for token in [
        &b"01"[..],
        b"00",
        b"-01",
        b"+1",
        b"1.",
        b".1",
        b"-.1",
        b"1e",
        b"1e+",
        b"1e-",
        b"e1",
        b"1.e2",
        b"true",
        b"false",
        b"null",
        b"[]",
        b"{}",
        b"1a",
        b"1 2",
        b"--1",
        b"0x1",
        b"",
    ] {
        let err = RequestId::parse_json_token(token).unwrap_err();
        assert!(
            matches!(
                err,
                IdError::InvalidToken | IdError::Empty | IdError::NonIntegral
            ),
            "token {token:?} produced {err:?}"
        );
    }
    assert_eq!(
        RequestId::parse_json_token(b"1.5"),
        Err(IdError::NonIntegral)
    );
    assert_eq!(
        RequestId::parse_json_token(b"1e-1"),
        Err(IdError::NonIntegral)
    );
    assert_eq!(
        RequestId::parse_json_token(b"10e-2"),
        Err(IdError::NonIntegral)
    );
}

#[test]
fn whitespace_is_outside_the_supplied_token_span() {
    assert_eq!(
        RequestId::parse_json_token(b" 1"),
        Err(IdError::LeadingWhitespace)
    );
    assert_eq!(
        RequestId::parse_json_token(b"1 "),
        Err(IdError::TrailingWhitespace)
    );
    assert_eq!(
        RequestId::parse_json_token(b"\t1"),
        Err(IdError::LeadingWhitespace)
    );
    assert_eq!(
        RequestId::parse_json_token(b"1\n"),
        Err(IdError::TrailingWhitespace)
    );
    assert_eq!(
        RequestId::parse_json_token(br#" "1""#),
        Err(IdError::LeadingWhitespace)
    );
    assert_eq!(
        RequestId::parse_json_token(br#""1" "#),
        Err(IdError::TrailingWhitespace)
    );
}

#[test]
fn huge_exponent_zero_is_zero_and_nonzero_fails_without_exponent_sized_allocation() {
    let mut zero = Vec::from(*b"0e");
    zero.extend(std::iter::repeat_n(b'9', 200));
    assert_eq!(parse(&zero).view(), IdView::Integer(0));

    let mut zero_frac = Vec::from(*b"0.000e");
    zero_frac.extend(std::iter::repeat_n(b'9', 80));
    assert_eq!(parse(&zero_frac).view(), IdView::Integer(0));

    let mut huge = Vec::from(*b"1e");
    huge.extend(std::iter::repeat_n(b'9', 200));
    assert_eq!(RequestId::parse_json_token(&huge), Err(IdError::OutOfRange));
    assert!(huge.capacity() < 1024, "test input itself stays bounded");

    let mut tiny = Vec::from(*b"1e-");
    tiny.extend(std::iter::repeat_n(b'9', 200));
    assert_eq!(
        RequestId::parse_json_token(&tiny),
        Err(IdError::NonIntegral)
    );
}

#[test]
fn escaped_strings_collide_by_decoded_value() {
    let plain = parse(br#""a""#);
    let escaped = parse(br#""\u0061""#);
    let pair = parse(br#""\uD83D\uDE00""#);
    let emoji = parse("\"😀\"".as_bytes());
    assert_eq!(plain, escaped);
    assert_eq!(plain.view(), IdView::String("a"));
    assert_eq!(pair, emoji);
    assert_eq!(hash_of(&plain), hash_of(&escaped));
}

#[test]
fn malformed_utf8_escapes_and_surrogates_reject() {
    assert!(RequestId::parse_json_token(b"\"\xff\"").is_err());
    assert!(RequestId::parse_json_token(br#""\uD800""#).is_err());
    assert!(RequestId::parse_json_token(br#""\uDE00""#).is_err());
    assert!(RequestId::parse_json_token(br#""\x41""#).is_err());
    assert!(RequestId::parse_json_token(br#""\u""#).is_err());
    assert!(RequestId::parse_json_token(br#""unterminated"#).is_err());
    assert!(RequestId::parse_json_token(br#""\""#).is_err());
}

#[test]
fn raw_decoded_and_canonical_1024_byte_limits() {
    let max_raw_ascii = {
        let mut token = Vec::with_capacity(MAX_ID_BYTES);
        token.push(b'"');
        token.extend(std::iter::repeat_n(b'a', MAX_ID_BYTES - 2));
        token.push(b'"');
        token
    };
    let ok = parse(&max_raw_ascii);
    assert_eq!(ok.view(), IdView::String(&"a".repeat(MAX_ID_BYTES - 2)));
    assert_eq!(ok.encoded_len(), MAX_ID_BYTES);
    assert!(ok.owned_heap_bytes() >= MAX_ID_BYTES - 2);

    let mut too_long = max_raw_ascii.clone();
    too_long.insert(1, b'b');
    assert_eq!(
        RequestId::parse_json_token(&too_long),
        Err(IdError::TokenTooLong)
    );

    let quotes = parse(br#""\"\\""#);
    assert_eq!(quotes.view(), IdView::String("\"\\"));
    assert!(quotes.encoded_len() > 2);

    let controls = parse(br#""\n\t\u0001""#);
    assert_eq!(controls.view(), IdView::String("\n\t\u{0001}"));

    let multibyte = parse("\"é你𝄞\"".as_bytes());
    assert_eq!(multibyte.view(), IdView::String("é你𝄞"));
    assert!(multibyte.encoded_len() >= "é你𝄞".len() + 2);
}

#[test]
fn integer_ids_own_no_heap_and_canonical_numeric_spelling_is_short() {
    let id = parse(b"10e-1");
    assert_eq!(id.encoded_len(), 1);
    assert_eq!(id.owned_heap_bytes(), 0);
    assert_eq!(parse(b"-0").encoded_len(), 1);
}
