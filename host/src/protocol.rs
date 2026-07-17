//! Wire protocol: JSON text frames for control, binary frames for PTY bytes.
//! `Replay` rides in JSON (base64) because it is a one-shot per attach;
//! steady-state output uses binary frames for throughput.

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

pub type SessionId = u32;

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
    },
    Attach {
        session_id: SessionId,
        replay: bool,
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
    ListSessions,
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
    Sessions {
        sessions: Vec<SessionInfo>,
    },
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
            } => {
                assert_eq!(profile.as_deref(), Some("powershell"));
                assert_eq!((cols, rows), (120, 30));
                assert!(cwd.is_none());
            }
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
