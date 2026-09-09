use termx_host::swarm::{
    rpc::PeerOperation,
    tools::{decode_tool_call, ToolInputError},
};

const GROUP: &str = "g_00000000000000000000000000000001";
const PEER: &str = "p_00000000000000000000000000000002";

#[test]
fn common_tools_preserve_group_navigation_and_send_dedup_key() {
    let call = decode_tool_call("whoami", "{}").unwrap();
    assert!(matches!(
        call,
        PeerOperation::WhoAmI {
            after_group: None,
            max_items: 64
        }
    ));
    let args = format!(
        r#"{{"group_id":"{GROUP}","navigation":{{"reset_after":{{"after_sequence":9007199254740993}}}},"max_items":128}}"#
    );
    let call = decode_tool_call("read_messages", &args).unwrap();
    assert!(matches!(
        call,
        PeerOperation::MailboxAfter {
            navigation: termx_swarm_core::model::MailboxNavigation::ResetAfter {
                after_sequence: 9_007_199_254_740_993
            },
            max_items: 128,
            ..
        }
    ));
    let args = format!(
        r#"{{"group_id":"{GROUP}","client_key":"retry-same-logical-message","recipients":["{PEER}"],"body":"finding","attachments":[]}}"#
    );
    let call = decode_tool_call("send_message", &args).unwrap();
    match call {
        PeerOperation::Send {
            group_id,
            client_key,
            recipients,
            body,
            ..
        } => {
            assert_eq!(group_id.as_str(), GROUP);
            assert_eq!(client_key, "retry-same-logical-message");
            assert_eq!(recipients.first().unwrap().as_str(), PEER);
            assert_eq!(body, "finding");
        }
        other => panic!("unexpected operation: {other:?}"),
    }
}

#[test]
fn common_tools_reject_authority_claims_and_arbitrary_commands() {
    for forbidden in ["sender_peer_id", "role", "pid", "path", "command", "owner"] {
        let args = format!(r#"{{"group_id":"{GROUP}","{forbidden}":"private-value"}}"#);
        let error = decode_tool_call("list_peers", &args).unwrap_err();
        assert_eq!(error, ToolInputError::InvalidArguments);
        assert!(!format!("{error:?} {error}").contains("private-value"));
    }
    assert_eq!(
        decode_tool_call("GetState", "{}").unwrap_err(),
        ToolInputError::UnknownTool
    );
    assert_eq!(
        decode_tool_call("fetch_context", "{}").unwrap_err(),
        ToolInputError::UnknownTool
    );
}

#[test]
fn common_tools_reject_duplicate_and_invalid_bounded_arguments() {
    assert!(decode_tool_call("whoami", r#"{"max_items":1,"max_items":2}"#).is_err());
    for bad in ["0", "129", "1.5", "-1", "null", "\"1\""] {
        assert!(decode_tool_call("whoami", &format!(r#"{{"max_items":{bad}}}"#)).is_err());
    }
    for bad in ["null", "[]", "true", "{", "{} {}"] {
        assert!(decode_tool_call("whoami", bad).is_err());
    }
    let args = format!(
        r#"{{"group_id":"{GROUP}","navigation":{{"reset_after":{{"after_sequence":1,"peer_id":"{PEER}"}}}}}}"#
    );
    assert!(decode_tool_call("read_messages", &args).is_err());
}

#[test]
fn each_tool_maps_only_its_expected_peer_operation() {
    let group = format!(r#"{{"group_id":"{GROUP}"}}"#);
    assert!(matches!(
        decode_tool_call("list_peers", &group).unwrap(),
        PeerOperation::ListPeers {
            after_peer: None,
            max_items: 64,
            ..
        }
    ));
    assert!(matches!(
        decode_tool_call("read_outgoing", &group).unwrap(),
        PeerOperation::ReadOutgoing {
            navigation: termx_swarm_core::model::MailboxNavigation::ResetAfter {
                after_sequence: 0
            },
            max_items: 64,
            ..
        }
    ));
    let message = "m_00000000000000000000000000000003";
    let args = format!(r#"{{"group_id":"{GROUP}","root":"{message}"}}"#);
    assert!(
        matches!(decode_tool_call("read_thread", &args).unwrap(), PeerOperation::ReadThread { root, .. } if root.as_str() == message)
    );
    let args = format!(r#"{{"group_id":"{GROUP}","message_id":"{message}"}}"#);
    assert!(
        matches!(decode_tool_call("acknowledge_message", &args).unwrap(), PeerOperation::Acknowledge { message_id, .. } if message_id.as_str() == message)
    );
    let args = format!(r#"{{"group_id":"{GROUP}","status":"reviewing the race condition"}}"#);
    assert!(
        matches!(decode_tool_call("publish_status", &args).unwrap(), PeerOperation::PublishStatus { status: Some(status), .. } if status == "reviewing the race condition")
    );
    assert!(matches!(
        decode_tool_call("publish_status", &group).unwrap(),
        PeerOperation::PublishStatus { status: None, .. }
    ));
    let reference = "s_00000000000000000000000000000004";
    let args = format!(r#"{{"group_id":"{GROUP}","source_reference_id":"{reference}"}}"#);
    assert!(
        matches!(decode_tool_call("resolve_attachment", &args).unwrap(), PeerOperation::ResolveAttachment { source_reference_id, .. } if source_reference_id.as_str() == reference)
    );
}

#[test]
fn explicit_navigation_and_attachments_round_trip_without_becoming_identity() {
    let source = "src_00000000000000000000000000000005";
    let args = format!(
        r#"{{"group_id":"{GROUP}","client_key":"same","recipients":["{PEER}"],"body":"exact\n\u0000\\\" text","topic":"topic","reply_to":null,"attachments":[{{"source_id":"{source}","snapshot_reference":"observed-v1"}}]}}"#
    );
    match decode_tool_call("send_message", &args).unwrap() {
        PeerOperation::Send {
            body,
            topic,
            attachments,
            ..
        } => {
            assert_eq!(body, "exact\n\0\\\" text");
            assert_eq!(topic.as_deref(), Some("topic"));
            assert_eq!(attachments[0].source_id.as_str(), source);
            assert_eq!(
                attachments[0].snapshot_reference.as_deref(),
                Some("observed-v1")
            );
        }
        _ => panic!("send mapped to another operation"),
    }
    let position = format!(
        r#"{{"group_id":"{GROUP}","peer_id":"{PEER}","binding_revision":1,"policy_revision":2,"scope":"mailbox","after_sequence":9007199254740993}}"#
    );
    let args = format!(r#"{{"group_id":"{GROUP}","navigation":{{"position":{position}}}}}"#);
    let operation = decode_tool_call("read_messages", &args).unwrap();
    match operation {
        PeerOperation::MailboxAfter {
            navigation: termx_swarm_core::model::MailboxNavigation::Position(position),
            ..
        } => {
            assert_eq!(position.peer_id().as_str(), PEER);
            assert_eq!(position.after_sequence(), 9_007_199_254_740_993);
        }
        _ => panic!("navigation did not survive decoding"),
    }
    // These are navigation addresses only. The decoder never manufactures a
    // VerifiedBinding, principal or owner command from their nested peer ID.
}

#[test]
fn escaped_duplicate_fields_and_input_size_are_rejected_before_dispatch() {
    for args in [
        r#"{"max_items":1,"max_\u0069tems":2}"#,
        r#"{"max_items":1,"max_items":1}"#,
    ] {
        assert_eq!(
            decode_tool_call("whoami", args).unwrap_err(),
            ToolInputError::InvalidArguments
        );
    }
    let args = format!(
        r#"{{"group_id":"{GROUP}","navigation":{{"reset_after":{{"after_sequence":0,"after_\u0073equence":1}}}}}}"#
    );
    assert_eq!(
        decode_tool_call("read_messages", &args).unwrap_err(),
        ToolInputError::InvalidArguments
    );
    let mut maximum = " ".repeat(termx_host::swarm::tools::MAX_TOOL_ARGUMENT_BYTES - 2);
    maximum.push_str("{}");
    assert!(decode_tool_call("whoami", &maximum).is_ok());
    maximum.push(' ');
    assert_eq!(
        decode_tool_call("whoami", &maximum).unwrap_err(),
        ToolInputError::TooLarge
    );
    for name in [
        "whoami",
        "list_peers",
        "read_messages",
        "read_thread",
        "read_outgoing",
        "send_message",
        "acknowledge_message",
        "publish_status",
        "resolve_attachment",
    ] {
        assert!(decode_tool_call(name, r#"{"owner":"private-value"}"#).is_err());
    }
}

#[test]
fn advertised_tools_have_executable_examples_and_a_bounded_closed_catalog() {
    let raw = termx_host::swarm::tools::tool_catalog_json();
    assert!(raw.len() < 16 * 1024);
    assert!(!raw.contains(['\r', '\n']));
    termx_swarm_mcp_protocol::validate_json(raw.as_bytes()).unwrap();
    let catalog: serde_json::Value = serde_json::from_str(raw).unwrap();
    let mut names = std::collections::BTreeSet::new();
    for tool in catalog["tools"].as_array().unwrap() {
        let name = tool["name"].as_str().unwrap();
        assert!(names.insert(name));
        assert_eq!(tool["inputSchema"]["additionalProperties"], false);
        let example = &tool["inputSchema"]["examples"][0];
        decode_tool_call(name, &serde_json::to_string(example).unwrap()).unwrap();
    }
    assert_eq!(names.len(), 9);
    assert!(!names.contains("fetch_context"));
}
