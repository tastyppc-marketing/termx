import io
import json
import unittest

from usage_accounting import AccountingUnavailable, summarize


def lines(*rows):
    return io.BytesIO(b''.join(json.dumps(row).encode() + b'\n' for row in rows))


def codex(response, input_tokens=100, **overrides):
    usage = dict(input_tokens=input_tokens, cached_input_tokens=80,
                 cache_write_input_tokens=0, output_tokens=20,
                 reasoning_output_tokens=5, total_tokens=input_tokens + 20)
    usage.update(overrides)
    return {'type': 'token_usage_record', 'payload': {
        'thread_id': 'owned', 'session_id': 'runtime',
        'response_id': response, 'usage': usage}}


def claude(response, **overrides):
    usage = dict(input_tokens=2, output_tokens=20,
                 cache_read_input_tokens=80, cache_creation_input_tokens=10)
    usage.update(overrides)
    return {'type': 'assistant', 'sessionId': 'owned', 'uuid': 'row-id',
            'message': {'id': response, 'usage': usage,
                        'content': [{'type': 'thinking', 'thinking': 'PRIVATE'}]}}


HEADER = {'type': 'session_meta', 'payload': {'id': 'owned'}}


class UsageAccountingTests(unittest.TestCase):
    def test_codex_counts_responses_once_across_cumulative_reset_and_replay(self):
        first = codex('response-1')
        replay = codex('response-1')
        replay['payload']['session_id'] = 'resumed-runtime'
        reset = {'type': 'event_msg', 'payload': {'type': 'token_count',
            'info': {'total_token_usage': {'total_tokens': 1}}}}
        result = summarize(lines(HEADER, first, reset, replay, codex('response-2', 200)), 'codex', 'owned')
        self.assertEqual(result['responses'], 2)
        self.assertEqual(result['duplicate_usage_records'], 1)
        self.assertEqual(result['counters']['input_tokens'], 300)
        self.assertEqual(result['counters']['total_tokens'], 340)

    def test_claude_repeated_blocks_are_one_response_and_categories_stay_separate(self):
        result = summarize(lines(claude('a'), claude('a'), claude('b')), 'claude', 'owned')
        self.assertEqual(result['responses'], 2)
        self.assertEqual(result['counters'], dict(input_tokens=4, output_tokens=40,
            cache_read_input_tokens=160, cache_creation_input_tokens=20))
        self.assertNotIn('PRIVATE', json.dumps(result))
        self.assertNotIn('total_tokens', result['counters'])

    def test_conflicting_counter_for_same_response_is_unavailable(self):
        with self.assertRaisesRegex(AccountingUnavailable, 'conflicting_response_usage'):
            summarize(lines(claude('a'), claude('a', output_tokens=21)), 'claude', 'owned')

    def test_missing_negative_boolean_and_string_counters_are_unavailable(self):
        variants = [None, -1, True, '2', 1 << 64]
        for value in variants:
            with self.subTest(value=value), self.assertRaises(AccountingUnavailable):
                summarize(lines(claude('a', input_tokens=value)), 'claude', 'owned')

    def test_missing_response_identity_is_not_guessed_from_record_uuid(self):
        row = claude(None)
        with self.assertRaisesRegex(AccountingUnavailable, 'response_identity'):
            summarize(lines(row), 'claude', 'owned')

    def test_other_conversation_and_missing_codex_header_are_unavailable(self):
        wrong = codex('a')
        wrong['payload']['thread_id'] = 'other'
        for records in [(HEADER, wrong), (codex('a'),)]:
            with self.subTest(records=len(records)), self.assertRaises(AccountingUnavailable):
                summarize(lines(*records), 'codex', 'owned')
        wrong_claude = claude('a')
        wrong_claude['sessionId'] = 'other'
        with self.assertRaises(AccountingUnavailable):
            summarize(lines(wrong_claude), 'claude', 'owned')

    def test_snapshots_alone_do_not_become_estimated_response_usage(self):
        snapshots = {'type': 'event_msg', 'payload': {'type': 'token_count',
            'info': {'total_token_usage': {'total_tokens': 500}}}}
        with self.assertRaisesRegex(AccountingUnavailable, 'no_response_usage'):
            summarize(lines(HEADER, snapshots), 'codex', 'owned')

    def test_partial_malformed_oversized_and_duplicate_json_keys_fail(self):
        cases = [b'{', b'{bad}\n', b'{}', b'{"type":"a","type":"b"}\n']
        for raw in cases:
            with self.subTest(raw=raw), self.assertRaises(AccountingUnavailable):
                summarize(io.BytesIO(raw), 'claude', 'owned')
        with self.assertRaisesRegex(AccountingUnavailable, 'record_too_large'):
            summarize(io.BytesIO(b'x' * 65 + b'\n'), 'claude', 'owned', max_record_bytes=64)

    def test_unknown_record_content_never_enters_result(self):
        result = summarize(lines({'type': 'private', 'content': 'SECRET'}, claude('a')), 'claude', 'owned')
        self.assertNotIn('SECRET', json.dumps(result))
        self.assertEqual(result['status'], 'recognized_source_usage')
        self.assertEqual(result['coverage']['full_run'], 'unverified')
        self.assertEqual(result['coverage']['descendant_usage'], 'unverified')
        self.assertEqual(result['coverage']['provider_billing'], 'unverified')
        self.assertEqual(result['coverage']['cross_source_overlap'], 'unverified')
        self.assertEqual(result['coverage']['native_schema'], 'recognized_record_variants_only')

    def test_unknown_harness_rejects(self):
        with self.assertRaises(ValueError):
            summarize(lines(claude('a')), 'other', 'owned')


if __name__ == '__main__':
    unittest.main()
