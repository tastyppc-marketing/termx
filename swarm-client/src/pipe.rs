use crate::{
    framing::{decode_body, encode_message_body, ConnectionPermit},
    wire::valid_id,
    DiscoveryRecord, FrameBudget, OwnerCredential, ProcessIdentity, ReceivedFrame, RequestEnvelope,
    ResponseEnvelope, VerifiedProcess, WireError, MAX_FRAME_BYTES, WIRE_VERSION,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    ffi::OsStr,
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, RawHandle},
    },
    ptr,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::windows::named_pipe::{NamedPipeClient, NamedPipeServer, ServerOptions},
};
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, GetHandleInformation, GetLastError, LocalFree, HANDLE, HANDLE_FLAG_INHERIT,
        INVALID_HANDLE_VALUE,
    },
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        },
        GetTokenInformation, TokenUser, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY,
        TOKEN_USER,
    },
    Storage::FileSystem::{
        CreateFileW, FILE_FLAG_OVERLAPPED, FILE_READ_DATA, FILE_WRITE_DATA, OPEN_EXISTING,
    },
    System::{
        Pipes::GetNamedPipeServerProcessId,
        Threading::{GetCurrentProcess, OpenProcessToken},
    },
};

// CreateFile named-pipe SQOS flags: require the SQOS bits and cap impersonation
// at identification when transferring the verified handle into Tokio.
const SECURITY_SQOS_PRESENT: u32 = 0x0010_0000;
const SECURITY_IDENTIFICATION: u32 = 0x0001_0000;

enum Pipe {
    Client(NamedPipeClient),
    Server(NamedPipeServer),
}
pub struct VerifiedPipe {
    pipe: tokio::sync::Mutex<Pipe>,
    budget: FrameBudget,
    server: VerifiedProcess,
    _connection: ConnectionPermit,
}
pub struct PipeServer {
    name: String,
    pending: Option<NamedPipeServer>,
    budget: FrameBudget,
    identity: ProcessIdentity,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ClientHello {
    version: u16,
    boot_id: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ServerHello {
    version: u16,
    boot_id: String,
    accepted: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct OwnerAuth {
    credential: String,
}

impl ClientHello {
    fn valid(&self) -> bool {
        self.version == WIRE_VERSION && valid_id(&self.boot_id)
    }
}

impl ServerHello {
    fn valid(&self) -> bool {
        self.version == WIRE_VERSION && valid_id(&self.boot_id)
    }
}

impl OwnerAuth {
    fn decode(&self) -> Result<Vec<u8>, WireError> {
        if self.credential.len() != 44 {
            return Err(WireError::InvalidFrame);
        }
        let decoded = STANDARD
            .decode(&self.credential)
            .map_err(|_| WireError::InvalidFrame)?;
        if decoded.len() != 32 || STANDARD.encode(&decoded) != self.credential {
            return Err(WireError::InvalidFrame);
        }
        Ok(decoded)
    }
}

fn decode_json<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, WireError> {
    let mut decoder = serde_json::Deserializer::from_slice(bytes);
    let value = T::deserialize(&mut decoder).map_err(|_| WireError::InvalidFrame)?;
    decoder.end().map_err(|_| WireError::InvalidFrame)?;
    Ok(value)
}

fn wide(s: &OsStr) -> Vec<u16> {
    s.encode_wide().chain(Some(0)).collect()
}
fn verify_noninheritable(handle: HANDLE) -> Result<(), WireError> {
    let mut flags = 0;
    if unsafe { GetHandleInformation(handle, &mut flags) } == 0 || flags & HANDLE_FLAG_INHERIT != 0
    {
        return Err(WireError::Io);
    }
    Ok(())
}
unsafe fn current_sid() -> Result<String, WireError> {
    let mut token = ptr::null_mut();
    if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
        return Err(WireError::Io);
    }
    let mut needed = 0;
    GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut needed);
    let mut buf = vec![0; needed as usize];
    if GetTokenInformation(
        token,
        TokenUser,
        buf.as_mut_ptr().cast(),
        needed,
        &mut needed,
    ) == 0
    {
        CloseHandle(token);
        return Err(WireError::Io);
    }
    let sid = (*(buf.as_ptr() as *const TOKEN_USER)).User.Sid;
    let mut text = ptr::null_mut();
    if ConvertSidToStringSidW(sid, &mut text) == 0 {
        CloseHandle(token);
        return Err(WireError::Io);
    }
    let mut n = 0;
    while *text.add(n) != 0 {
        n += 1
    }
    let out = String::from_utf16_lossy(std::slice::from_raw_parts(text, n));
    let _ = LocalFree(text.cast());
    CloseHandle(token);
    Ok(out)
}
fn create_server(name: &str, first: bool) -> Result<NamedPipeServer, WireError> {
    unsafe {
        let sddl: Vec<u16> = format!("D:P(A;;GA;;;{})\0", current_sid()?)
            .encode_utf16()
            .collect();
        let mut sd: PSECURITY_DESCRIPTOR = ptr::null_mut();
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut sd,
            ptr::null_mut(),
        ) == 0
        {
            return Err(WireError::Io);
        }
        let mut sa = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: sd,
            bInheritHandle: 0,
        };
        let mut options = ServerOptions::new();
        options
            .first_pipe_instance(first)
            .reject_remote_clients(true);
        let result = options
            .create_with_security_attributes_raw(name, ptr::addr_of_mut!(sa).cast())
            .map_err(|_| WireError::Io)
            .and_then(|server| {
                verify_noninheritable(server.as_raw_handle() as HANDLE)?;
                Ok(server)
            });
        let _ = LocalFree(sd);
        result
    }
}
impl PipeServer {
    pub fn bind(name: &str, budget: FrameBudget) -> Result<Self, WireError> {
        let pending = create_server(name, true)?;
        let identity = VerifiedProcess::open(std::process::id())
            .map_err(|_| WireError::Io)?
            .identity();
        Ok(Self {
            name: name.into(),
            pending: Some(pending),
            budget,
            identity,
        })
    }
    pub fn identity(&self) -> ProcessIdentity {
        self.identity
    }
    pub async fn accept(&mut self) -> Result<VerifiedPipe, WireError> {
        let server = self.pending.take().ok_or(WireError::Io)?;
        server.connect().await.map_err(|_| WireError::Io)?;
        self.pending = Some(create_server(&self.name, false)?);
        let connection = self.budget.reserve_connection()?;
        let retained = VerifiedProcess::verify(self.identity).map_err(|_| WireError::Io)?;
        Ok(VerifiedPipe {
            pipe: tokio::sync::Mutex::new(Pipe::Server(server)),
            budget: self.budget.clone(),
            server: retained,
            _connection: connection,
        })
    }
    pub async fn accept_owner(
        &mut self,
        boot_id: &str,
        credential: &OwnerCredential,
    ) -> Result<VerifiedPipe, WireError> {
        let mut pipe = self.accept().await?;
        let hello_bytes = pipe.recv_bytes().await?;
        let hello: ClientHello = decode_json(hello_bytes.as_ref())?;
        let accepted = hello.valid() && valid_id(boot_id) && hello.boot_id == boot_id;
        pipe.send_bytes(
            &serde_json::to_vec(&ServerHello {
                version: WIRE_VERSION,
                boot_id: boot_id.into(),
                accepted,
            })
            .map_err(|_| WireError::InvalidFrame)?,
        )
        .await?;
        if !accepted {
            return Err(WireError::InvalidFrame);
        }
        let auth_bytes = pipe.recv_bytes().await?;
        let auth: OwnerAuth = decode_json(auth_bytes.as_ref())?;
        if !credential.matches_bytes(&auth.decode()?) {
            return Err(WireError::InvalidFrame);
        }
        Ok(pipe)
    }
    pub async fn accept_peer(&mut self, boot_id: &str) -> Result<VerifiedPipe, WireError> {
        let mut pipe = self.accept().await?;
        let hello_bytes = pipe.recv_bytes().await?;
        let hello: ClientHello = decode_json(hello_bytes.as_ref())?;
        let accepted = hello.valid() && valid_id(boot_id) && hello.boot_id == boot_id;
        pipe.send_bytes(
            &serde_json::to_vec(&ServerHello {
                version: WIRE_VERSION,
                boot_id: boot_id.into(),
                accepted,
            })
            .map_err(|_| WireError::InvalidFrame)?,
        )
        .await?;
        if accepted {
            Ok(pipe)
        } else {
            Err(WireError::InvalidFrame)
        }
    }
}
impl VerifiedPipe {
    pub async fn connect(name: &str, expected: ProcessIdentity) -> Result<Self, WireError> {
        unsafe {
            let h = CreateFileW(
                wide(OsStr::new(name)).as_ptr(),
                FILE_READ_DATA | FILE_WRITE_DATA,
                0,
                ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                ptr::null_mut(),
            );
            if h == INVALID_HANDLE_VALUE {
                return Err(WireError::Native(GetLastError()));
            }
            if let Err(error) = verify_noninheritable(h) {
                CloseHandle(h);
                return Err(error);
            }
            let mut pid = 0;
            if GetNamedPipeServerProcessId(h, &mut pid) == 0 || pid != expected.pid {
                CloseHandle(h);
                return Err(WireError::Io);
            }
            let retained = match VerifiedProcess::verify(expected) {
                Ok(v) => v,
                Err(_) => {
                    CloseHandle(h);
                    return Err(WireError::Io);
                }
            };
            let client = match NamedPipeClient::from_raw_handle(h as RawHandle) {
                Ok(v) => v,
                Err(_) => {
                    CloseHandle(h);
                    return Err(WireError::Io);
                }
            };
            let budget = FrameBudget::new(MAX_FRAME_BYTES * 2);
            let connection = budget.reserve_connection()?;
            Ok(Self {
                pipe: tokio::sync::Mutex::new(Pipe::Client(client)),
                budget,
                server: retained,
                _connection: connection,
            })
        }
    }
    pub fn server_identity(&self) -> ProcessIdentity {
        self.server.identity()
    }
    pub async fn send_bytes(&self, bytes: &[u8]) -> Result<(), WireError> {
        if bytes.len() > MAX_FRAME_BYTES {
            return Err(WireError::FrameTooLarge);
        }
        let _permit = self.budget.reserve(bytes.len() + 4)?;
        let mut guard = self.pipe.lock().await;
        let prefix = (bytes.len() as u32).to_le_bytes();
        match &mut *guard {
            Pipe::Client(p) => {
                p.write_all(&prefix).await.map_err(map_io)?;
                p.write_all(bytes).await.map_err(map_io)?;
                p.flush().await.map_err(map_io)
            }
            Pipe::Server(p) => {
                p.write_all(&prefix).await.map_err(map_io)?;
                p.write_all(bytes).await.map_err(map_io)?;
                p.flush().await.map_err(map_io)
            }
        }
    }
    pub async fn send_request(&self, request: &RequestEnvelope) -> Result<(), WireError> {
        self.send_bytes(&encode_message_body(request)?).await
    }
    pub async fn send_response(&self, response: &ResponseEnvelope) -> Result<(), WireError> {
        self.send_bytes(&encode_message_body(response)?).await
    }
    pub async fn recv_bytes(&mut self) -> Result<ReceivedFrame, WireError> {
        let mut prefix = [0; 4];
        let mut guard = self.pipe.lock().await;
        let read = match &mut *guard {
            Pipe::Client(p) => p.read_exact(&mut prefix).await,
            Pipe::Server(p) => p.read_exact(&mut prefix).await,
        };
        read.map_err(map_io)?;
        let len = u32::from_le_bytes(prefix) as usize;
        if len > MAX_FRAME_BYTES {
            return Err(WireError::FrameTooLarge);
        }
        let _permit = self.budget.reserve(len + 4)?;
        let mut out = vec![0; len];
        match &mut *guard {
            Pipe::Client(p) => p.read_exact(&mut out).await.map_err(map_io)?,
            Pipe::Server(p) => p.read_exact(&mut out).await.map_err(map_io)?,
        };
        Ok(ReceivedFrame {
            bytes: out,
            _permit,
        })
    }
    pub async fn recv_request(&mut self) -> Result<RequestEnvelope, WireError> {
        let frame = self.recv_bytes().await?;
        decode_body(frame.as_ref())
    }
    pub async fn recv_response(&mut self) -> Result<ResponseEnvelope, WireError> {
        let frame = self.recv_bytes().await?;
        decode_body(frame.as_ref())
    }
}
fn map_io(e: std::io::Error) -> WireError {
    if matches!(
        e.kind(),
        std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::UnexpectedEof
    ) {
        WireError::Disconnected
    } else {
        WireError::Io
    }
}
async fn hello(discovery: &DiscoveryRecord) -> Result<VerifiedPipe, WireError> {
    if !discovery.validate() {
        return Err(WireError::InvalidFrame);
    }
    let mut pipe = VerifiedPipe::connect(&discovery.pipe_name, discovery.server).await?;
    pipe.send_bytes(
        &serde_json::to_vec(&ClientHello {
            version: WIRE_VERSION,
            boot_id: discovery.boot_id.clone(),
        })
        .map_err(|_| WireError::InvalidFrame)?,
    )
    .await?;
    let response_bytes = pipe.recv_bytes().await?;
    let response: ServerHello = decode_json(response_bytes.as_ref())?;
    if !response.valid() || response.boot_id != discovery.boot_id || !response.accepted {
        return Err(WireError::InvalidFrame);
    }
    Ok(pipe)
}
pub(crate) async fn connect_owner(
    discovery: &DiscoveryRecord,
    credential: &OwnerCredential,
) -> Result<VerifiedPipe, WireError> {
    let pipe = hello(discovery).await?;
    pipe.send_bytes(
        &serde_json::to_vec(&OwnerAuth {
            credential: STANDARD.encode(credential.bytes()),
        })
        .map_err(|_| WireError::InvalidFrame)?,
    )
    .await?;
    Ok(pipe)
}
pub(crate) async fn connect_peer(discovery: &DiscoveryRecord) -> Result<VerifiedPipe, WireError> {
    hello(discovery).await
}
