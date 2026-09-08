"""Offline accounting for explicitly selected, owned evaluation transcripts.

Counts native response records, never cumulative snapshots or transcript blocks.
Unknown/incomplete accounting fails rather than inventing usage. No model calls,
source discovery, transcript text export, pricing, or product RPC is provided.
Retained map memory grows with distinct response IDs. Decoding also uses transient
memory for one bounded input record and its Python objects; the record byte limit
is not an exact process-memory limit.
"""

import argparse
import hashlib
import json
import sys


COUNTERS = {
    'codex': ('input_tokens', 'cached_input_tokens', 'cache_write_input_tokens',
              'output_tokens', 'reasoning_output_tokens', 'total_tokens'),
    'claude': ('input_tokens', 'output_tokens', 'cache_read_input_tokens',
               'cache_creation_input_tokens'),
}
MAX_RECORD_BYTES = 16 * 1024 * 1024
MAX_COUNTER = (1 << 64) - 1


class AccountingUnavailable(ValueError):
    def __init__(self, reason, record=None):
        self.reason = reason
        self.record = record
        super().__init__(reason)


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate key')
        result[key] = value
    return result


def _constant(_value):
    raise ValueError('non-finite JSON')


def _identifier(value):
    return isinstance(value, str) and 0 < len(value) <= 512 and not any(ord(c) < 32 for c in value)


def summarize(stream, harness, conversation_id, *, max_record_bytes=MAX_RECORD_BYTES):
    """Read a binary JSONL stream and count recognized native response evidence.

    Per-response counters must be present nonnegative integers. Repeated IDs
    with identical counters deduplicate even across runtime resumes; conflicting
    observations are unavailable, not silently maximized or summed. Counter
    categories retain their native meanings and can overlap; do not add them all
    together. Caller must select and authorize a finalized source before invoking
    this. The hash binds the bytes read; it is not a live-writer snapshot protocol.
    """
    if harness not in COUNTERS or not _identifier(conversation_id):
        raise ValueError('unsupported harness or invalid expected conversation')
    if type(max_record_bytes) is not int or max_record_bytes < 1:
        raise ValueError('invalid record bound')
    fields = COUNTERS[harness]
    responses = {}
    totals = dict.fromkeys(fields, 0)
    digest = hashlib.sha256()
    records = duplicates = usage_records = source_bytes = 0
    identity_seen = False
    while True:
        raw = stream.readline(max_record_bytes + 1)
        if not raw:
            break
        records += 1
        if len(raw) > max_record_bytes:
            raise AccountingUnavailable('record_too_large', records)
        if not raw.endswith(b'\n'):
            raise AccountingUnavailable('incomplete_record', records)
        digest.update(raw)
        source_bytes += len(raw)
        try:
            row = json.loads(raw.decode('utf-8-sig' if records == 1 else 'utf-8'),
                             object_pairs_hook=_object, parse_constant=_constant)
        except (ValueError, UnicodeError, RecursionError):
            raise AccountingUnavailable('invalid_json_record', records) from None
        if not isinstance(row, dict):
            raise AccountingUnavailable('invalid_record_shape', records)
        if harness == 'codex':
            if row.get('type') == 'session_meta':
                payload = row.get('payload')
                if not isinstance(payload, dict) or payload.get('id') != conversation_id:
                    raise AccountingUnavailable('conversation_mismatch', records)
                identity_seen = True
            if row.get('type') != 'token_usage_record':
                continue
            payload = row.get('payload')
            if not isinstance(payload, dict) or payload.get('thread_id') != conversation_id:
                raise AccountingUnavailable('conversation_mismatch', records)
            response_id = payload.get('response_id')
            usage = payload.get('usage')
        else:
            if row.get('type') != 'assistant':
                continue
            if row.get('sessionId') != conversation_id:
                raise AccountingUnavailable('conversation_mismatch', records)
            identity_seen = True
            message = row.get('message')
            if not isinstance(message, dict):
                raise AccountingUnavailable('invalid_message_shape', records)
            response_id = message.get('id')
            usage = message.get('usage')
        if not _identifier(response_id):
            raise AccountingUnavailable('missing_response_identity', records)
        if not isinstance(usage, dict):
            raise AccountingUnavailable('missing_response_usage', records)
        values = tuple(usage.get(field) for field in fields)
        if any(type(value) is not int or not 0 <= value <= MAX_COUNTER for value in values):
            raise AccountingUnavailable('invalid_or_missing_counter', records)
        usage_records += 1
        if response_id in responses:
            if responses[response_id] != values:
                raise AccountingUnavailable('conflicting_response_usage', records)
            duplicates += 1
            continue
        responses[response_id] = values
        for field, value in zip(fields, values):
            totals[field] += value
    if not identity_seen:
        raise AccountingUnavailable('source_identity_unverified')
    if not responses:
        raise AccountingUnavailable('no_response_usage')
    return {'status': 'recognized_source_usage', 'harness': harness, 'conversation_id': conversation_id,
            'responses': len(responses), 'usage_records': usage_records,
            'duplicate_usage_records': duplicates, 'counters': totals,
            'source_records': records, 'source_bytes': source_bytes,
            'source_sha256': digest.hexdigest(),
            'method': 'distinct_native_response_ids',
            'scope': 'recognized response records in selected source; includes recorded setup and resumes',
            'coverage': {'finalized_source': 'caller_precondition',
                         'native_schema': 'recognized_record_variants_only',
                         'full_run': 'unverified', 'descendant_usage': 'unverified',
                         'provider_billing': 'unverified', 'cross_source_overlap': 'unverified'}}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--harness', required=True, choices=COUNTERS)
    parser.add_argument('--source', required=True, help='Explicit owned JSONL file; never auto-discovered')
    parser.add_argument('--conversation-id', required=True)
    args = parser.parse_args(argv)
    try:
        with open(args.source, 'rb') as stream:
            result = summarize(stream, args.harness, args.conversation_id)
    except AccountingUnavailable as error:
        result = {'status': 'unavailable', 'reason': error.reason, 'record': error.record}
    except (OSError, ValueError):
        result = {'status': 'unavailable', 'reason': 'source_or_argument_error'}
    print(json.dumps(result, sort_keys=True))
    return 0 if result['status'] == 'recognized_source_usage' else 1


if __name__ == '__main__':
    sys.exit(main())
