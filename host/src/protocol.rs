//! Wire protocol: JSON text frames for control, binary frames for PTY bytes.
//!
//! `Replay` rides in JSON (base64); steady-state output uses binary frames
//! for throughput. Replay is NOT one-shot: besides the initial attach replay,
//! the host sends unsolicited resync Replays whenever a client lags the live
//! broadcast — including to `replay: false` attachers (they opted out of
//! history, not of resync). Each Replay is authoritative for
//! `[start_offset, start_offset + len)`, and `start_offset` may jump FORWARD
//! past bytes the client never received (ring eviction under sustained lag):
//! clients must treat such a gap as lost scrollback, render the replay, and
//! continue — never wait for the missing range.

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

pub type SessionId = u32;

fn shell_integration_default() -> bool {
    true
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMsg {
    Auth {
        token: String,
    },
    CreateSession {
        profile: Option<String>,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
        /// Inject the shell's OSC 9;9 cwd-reporting prompt hook. Omitted means
        /// ON: clients predating this field still get cwd tracking, and the
        /// wire stays backward compatible.
        #[serde(default = "shell_integration_default")]
        shell_integration: bool,
    },
    Attach {
        session_id: SessionId,
        replay: bool,
        /// Resume cursor: replay only bytes at or after this absolute stream
        /// offset. Omitted means "replay the whole ring" — the pre-reconnect
        /// behavior, so an older client stays wire-compatible. A cursor older
        /// than the ring start is clamped to it and the client's existing
        /// lost-scrollback path reports the gap.
        #[serde(default)]
        since_offset: Option<u64>,
    },
    Detach {
        session_id: SessionId,
    },
    Resize {
        session_id: SessionId,
        cols: u16,
        rows: u16,
    },
    CloseSession {
        session_id: SessionId,
    },
    /// Page backward through a session's disk-spilled scrollback: return up to
    /// `max_bytes` (clamped host-side) ending just before `before_offset`.
    ReadHistory {
        session_id: SessionId,
        before_offset: u64,
        max_bytes: u32,
    },
    ListSessions,
    /// Ask whether a live session's shell has anything running inside it.
    /// The saved-resume flow uses the answer to choose between reattaching
    /// untouched and typing a resume command into the idle shell.
    ProbeSession {
        session_id: SessionId,
    },
    SetLayout {
        layout: serde_json::Value,
    },
    GetState,
    Shutdown,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HostMsg {
    AuthOk {
        version: String,
        sessions: Vec<SessionInfo>,
    },
    AuthErr {
        reason: String,
    },
    SessionCreated {
        info: SessionInfo,
    },
    Replay {
        session_id: SessionId,
        start_offset: u64,
        data_b64: String,
    },
    SessionExited {
        session_id: SessionId,
        exit_code: Option<u32>,
    },
    SessionClosed {
        session_id: SessionId,
    },
    /// Reply to ReadHistory. An absent session or spill file is NOT an error —
    /// it comes back as an empty slice with `at_start`, because "this session
    /// has no history" is the normal case, not a failure.
    History {
        session_id: SessionId,
        start_offset: u64,
        data_b64: String,
        at_start: bool,
    },
    Sessions {
        sessions: Vec<SessionInfo>,
    },
    /// Reply to ProbeSession. An unknown or dead session is `alive: false`,
    /// never an error. `busy` errs toward true: a probe that cannot see the
    /// process tree reports an occupied shell, because the caller's safe move
    /// is to reattach and type nothing.
    SessionProbe {
        session_id: SessionId,
        alive: bool,
        busy: bool,
    },
    /// Ack that SetLayout was applied AND durably persisted; persist failures
    /// come back as Error{context:"set_layout"} instead of silence.
    LayoutSaved,
    State {
        layout: serde_json::Value,
        sessions: Vec<SessionInfo>,
    },
    Error {
        context: String,
        message: String,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: SessionId,
    pub profile: String,
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
    pub alive: bool,
    /// OS pid of the shell process (None if unavailable). Lets the UI show
    /// diagnostics and lets tests verify the tree actually dies.
    #[serde(default)]
    pub pid: Option<u32>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Frame {
    Output {
        session_id: SessionId,
        offset: u64,
        data: Vec<u8>,
    },
    Input {
        session_id: SessionId,
        data: Vec<u8>,
    },
}

const TAG_OUTPUT: u8 = 1;
const TAG_INPUT: u8 = 2;

pub fn encode_frame(f: &Frame) -> Vec<u8> {
    match f {
        Frame::Output {
            session_id,
            offset,
            data,
        } => {
            let mut buf = Vec::with_capacity(13 + data.len());
            buf.push(TAG_OUTPUT);
            buf.extend_from_slice(&session_id.to_le_bytes());
            buf.extend_from_slice(&offset.to_le_bytes());
            buf.extend_from_slice(data);
            buf
        }
        Frame::Input { session_id, data } => {
            let mut buf = Vec::with_capacity(5 + data.len());
            buf.push(TAG_INPUT);
            buf.extend_from_slice(&session_id.to_le_bytes());
            buf.extend_from_slice(data);
            buf
        }
    }
}

pub fn decode_frame(buf: &[u8]) -> Result<Frame> {
    if buf.is_empty() {
        bail!("empty frame");
    }
    match buf[0] {
        TAG_OUTPUT => {
            if buf.len() < 13 {
                bail!("output frame too short: {} bytes", buf.len());
            }
            Ok(Frame::Output {
                session_id: u32::from_le_bytes(buf[1..5].try_into().unwrap()),
                offset: u64::from_le_bytes(buf[5..13].try_into().unwrap()),
                data: buf[13..].to_vec(),
            })
        }
        TAG_INPUT => {
            if buf.len() < 5 {
                bail!("input frame too short: {} bytes", buf.len());
            }
            Ok(Frame::Input {
                session_id: u32::from_le_bytes(buf[1..5].try_into().unwrap()),
                data: buf[5..].to_vec(),
            })
        }
        tag => bail!("unknown frame tag {tag}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_msg_json_round_trip() {
        let m = ClientMsg::CreateSession {
            profile: Some("powershell".into()),
            cwd: None,
            cols: 120,
            rows: 30,
            shell_integration: false,
        };
        let text = serde_json::to_string(&m).unwrap();
        assert!(
            text.contains(r#""type":"create_session""#),
            "tagged snake_case: {text}"
        );
        let back: ClientMsg = serde_json::from_str(&text).unwrap();
        match back {
            ClientMsg::CreateSession {
                profile,
                cols,
                rows,
                cwd,
                shell_integration,
            } => {
                assert_eq!(profile.as_deref(), Some("powershell"));
                assert_eq!((cols, rows), (120, 30));
                assert!(cwd.is_none());
                assert!(!shell_integration, "explicit false round-trips");
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    /// Wire compatibility: a client built before shell integration existed sends
    /// no `shell_integration` key and must still get the prompt hooks.
    #[test]
    fn create_session_without_shell_integration_field_defaults_to_true() {
        let legacy = r#"{"type":"create_session","profile":"cmd","cwd":null,"cols":80,"rows":25}"#;
        match serde_json::from_str::<ClientMsg>(legacy).unwrap() {
            ClientMsg::CreateSession {
                shell_integration, ..
            } => assert!(shell_integration, "omitted field must mean ON"),
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn create_session_honors_an_explicit_shell_integration_false() {
        let text = r#"{"type":"create_session","cols":80,"rows":25,"shell_integration":false}"#;
        match serde_json::from_str::<ClientMsg>(text).unwrap() {
            ClientMsg::CreateSession {
                shell_integration, ..
            } => assert!(!shell_integration),
            other => panic!("wrong variant: {other:?}"),
        }
    }

    /// Reconnect resync rides an optional cursor on Attach. An old client omits
    /// it and must keep getting the whole ring.
    #[test]
    fn attach_since_offset_is_optional_on_the_wire() {
        let legacy = r#"{"type":"attach","session_id":3,"replay":true}"#;
        match serde_json::from_str::<ClientMsg>(legacy).unwrap() {
            ClientMsg::Attach { since_offset, .. } => {
                assert_eq!(since_offset, None, "omitted cursor means replay-all");
            }
            other => panic!("wrong variant: {other:?}"),
        }

        let resync = r#"{"type":"attach","session_id":3,"replay":true,"since_offset":4096}"#;
        match serde_json::from_str::<ClientMsg>(resync).unwrap() {
            ClientMsg::Attach { since_offset, .. } => assert_eq!(since_offset, Some(4096)),
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn host_msg_json_round_trip() {
        let m = HostMsg::SessionExited {
            session_id: 7,
            exit_code: Some(0),
        };
        let text = serde_json::to_string(&m).unwrap();
        let back: HostMsg = serde_json::from_str(&text).unwrap();
        match back {
            HostMsg::SessionExited {
                session_id,
                exit_code,
            } => {
                assert_eq!(session_id, 7);
                assert_eq!(exit_code, Some(0));
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn output_frame_round_trip() {
        let f = Frame::Output {
            session_id: 42,
            offset: 1_000_000,
            data: b"hi\r\n".to_vec(),
        };
        let buf = encode_frame(&f);
        assert_eq!(buf[0], 1);
        match decode_frame(&buf).unwrap() {
            Frame::Output {
                session_id,
                offset,
                data,
            } => {
                assert_eq!(session_id, 42);
                assert_eq!(offset, 1_000_000);
                assert_eq!(data, b"hi\r\n");
            }
            other => panic!("wrong frame: {other:?}"),
        }
    }

    #[test]
    fn input_frame_round_trip() {
        let f = Frame::Input {
            session_id: 3,
            data: b"dir\r".to_vec(),
        };
        let buf = encode_frame(&f);
        assert_eq!(buf[0], 2);
        match decode_frame(&buf).unwrap() {
            Frame::Input { session_id, data } => {
                assert_eq!(session_id, 3);
                assert_eq!(data, b"dir\r");
            }
            other => panic!("wrong frame: {other:?}"),
        }
    }

    #[test]
    fn truncated_frame_is_error() {
        assert!(decode_frame(&[1, 0, 0]).is_err());
        assert!(decode_frame(&[]).is_err());
        assert!(decode_frame(&[9, 0, 0, 0, 0]).is_err(), "unknown tag");
    }
}
