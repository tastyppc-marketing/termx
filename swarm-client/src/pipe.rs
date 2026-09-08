use crate::{
    framing::{decode_body, encode_message_body, ConnectionPermit, FramePermit},
    wire::valid_id,
    DiscoveryRecord, FrameBudget, OwnerCredential, ProcessIdentity, ReceivedFrame, RequestEnvelope,
    ResponseEnvelope, VerifiedProcess, WireError, MAX_FRAME_BYTES,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    collections::VecDeque,
    ffi::OsStr,
    fmt,
    future::Future,
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, RawHandle},
    },
    pin::Pin,
    ptr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    task::{Context, Poll},
    time::Duration,
};
use tokio::{
    io::{split, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf, ReadHalf, WriteHalf},
    net::windows::named_pipe::{NamedPipeClient, NamedPipeServer, ServerOptions},
    sync::{watch, Mutex},
    time::{sleep, timeout, Instant},
};
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, GetHandleInformation, GetLastError, LocalFree, ERROR_PIPE_BUSY, HANDLE,
        HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE,
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
        Pipes::{GetNamedPipeClientProcessId, GetNamedPipeServerProcessId},
        Threading::{GetCurrentProcess, OpenProcessToken},
    },
};

pub const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
pub const DEFAULT_CONNECT_RETRY_INTERVAL: Duration = Duration::from_millis(10);
pub const DEFAULT_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(2);

// CreateFile named-pipe SQOS flags: require the SQOS bits and cap impersonation
// at identification when transferring the verified handle into Tokio.
const SECURITY_SQOS_PRESENT: u32 = 0x0010_0000;
const SECURITY_IDENTIFICATION: u32 = 0x0001_0000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TransportOptions {
    pub connect_timeout: Duration,
    pub connect_retry_interval: Duration,
    pub handshake_timeout: Duration,
}

impl Default for TransportOptions {
    fn default() -> Self {
        Self {
            connect_timeout: DEFAULT_CONNECT_TIMEOUT,
            connect_retry_interval: DEFAULT_CONNECT_RETRY_INTERVAL,
            handshake_timeout: DEFAULT_HANDSHAKE_TIMEOUT,
        }
    }
}

enum PipeStream {
    Client(NamedPipeClient),
    Server(NamedPipeServer),
}

impl AsyncRead for PipeStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        match &mut *self {
            Self::Client(pipe) => Pin::new(pipe).poll_read(cx, buffer),
            Self::Server(pipe) => Pin::new(pipe).poll_read(cx, buffer),
        }
    }
}

impl AsyncWrite for PipeStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        match &mut *self {
            Self::Client(pipe) => Pin::new(pipe).poll_write(cx, buffer),
            Self::Server(pipe) => Pin::new(pipe).poll_write(cx, buffer),
        }
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match &mut *self {
            Self::Client(pipe) => Pin::new(pipe).poll_flush(cx),
            Self::Server(pipe) => Pin::new(pipe).poll_flush(cx),
        }
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match &mut *self {
            Self::Client(pipe) => Pin::new(pipe).poll_shutdown(cx),
            Self::Server(pipe) => Pin::new(pipe).poll_shutdown(cx),
        }
    }
}

struct ConnectionState {
    poisoned: AtomicBool,
    poison_signal: watch::Sender<bool>,
}

impl ConnectionState {
    fn new() -> Arc<Self> {
        let (poison_signal, _) = watch::channel(false);
        Arc::new(Self {
            poisoned: AtomicBool::new(false),
            poison_signal,
        })
    }

    fn is_poisoned(&self) -> bool {
        self.poisoned.load(Ordering::Acquire)
    }

    fn poison(&self) {
        if !self.poisoned.swap(true, Ordering::AcqRel) {
            self.poison_signal.send_replace(true);
        }
    }

    async fn wait_until_poisoned(&self) {
        let mut receiver = self.poison_signal.subscribe();
        if *receiver.borrow() {
            return;
        }
        let _ = receiver.changed().await;
    }
}

struct ProgressGuard {
    state: Arc<ConnectionState>,
    started: bool,
    complete: bool,
}

impl ProgressGuard {
    fn new(state: Arc<ConnectionState>) -> Self {
        Self {
            state,
            started: false,
            complete: false,
        }
    }

    fn start(&mut self) {
        self.started = true;
    }

    fn complete(&mut self) {
        self.complete = true;
    }
}

impl Drop for ProgressGuard {
    fn drop(&mut self) {
        if self.started && !self.complete {
            self.state.poison();
        }
    }
}

struct FrameReservation {
    _permit: FramePermit,
    connection: Arc<ConnectionState>,
    reserved_bytes: usize,
    body_capacity: usize,
}

/// One exclusive right to send a single reserved frame on one `VerifiedPipe`.
///
/// Not `Clone` and not `Deserialize`. `send_reserved` consumes the token once.
/// Share reservation lifetime with [`FrameCreditHandle`]; cloning a handle does
/// not duplicate this send right or reserve more bytes.
///
/// ```
/// use termx_swarm_client::ReservedFrameSend;
/// fn capacities(token: &ReservedFrameSend) -> (usize, usize) {
///     (token.body_capacity(), token.reserved_bytes())
/// }
/// ```
///
/// ```
/// fn clone_handle(
///     handle: termx_swarm_client::FrameCreditHandle,
/// ) -> (termx_swarm_client::FrameCreditHandle, termx_swarm_client::FrameCreditHandle) {
///     (handle.clone(), handle)
/// }
/// ```
///
/// ```
/// termx_swarm_client::assert_deserialize_owned::<termx_swarm_client::DiscoveryRecord>();
/// ```
///
/// ```compile_fail
/// use termx_swarm_client::ReservedFrameSend;
/// fn duplicate(token: ReservedFrameSend) -> (ReservedFrameSend, ReservedFrameSend) {
///     (token.clone(), token)
/// }
/// ```
///
/// ```compile_fail
/// fn send_twice(pipe: &termx_swarm_client::VerifiedPipe, token: termx_swarm_client::ReservedFrameSend, body: &[u8]) {
///     let _ = pipe.send_reserved(token, body);
///     let _ = pipe.send_reserved(token, body);
/// }
/// ```
///
/// ```compile_fail
/// termx_swarm_client::assert_deserialize_owned::<termx_swarm_client::ReservedFrameSend>();
/// ```
///
/// ```compile_fail
/// fn send_with_handle(pipe: &termx_swarm_client::VerifiedPipe, handle: termx_swarm_client::FrameCreditHandle, body: &[u8]) {
///     let _ = pipe.send_reserved(handle, body);
/// }
/// ```
pub struct ReservedFrameSend {
    reservation: Arc<FrameReservation>,
}

/// Shared ownership of one actual frame reservation. Cannot authorize a send.
///
/// Cloning does not reserve more bytes or release the original credit. Debug
/// reports only the reserved byte count.
#[derive(Clone)]
pub struct FrameCreditHandle {
    reservation: Arc<FrameReservation>,
}

impl fmt::Debug for ReservedFrameSend {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ReservedFrameSend")
            .field("reserved_bytes", &self.reservation.reserved_bytes)
            .field("body_capacity", &self.reservation.body_capacity)
            .finish()
    }
}

impl fmt::Debug for FrameCreditHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FrameCreditHandle")
            .field("reserved_bytes", &self.reservation.reserved_bytes)
            .finish()
    }
}

impl ReservedFrameSend {
    pub fn credit_handle(&self) -> FrameCreditHandle {
        FrameCreditHandle {
            reservation: self.reservation.clone(),
        }
    }

    pub fn body_capacity(&self) -> usize {
        self.reservation.body_capacity
    }

    pub fn reserved_bytes(&self) -> usize {
        self.reservation.reserved_bytes
    }

    fn belongs_to(&self, state: &Arc<ConnectionState>) -> bool {
        Arc::ptr_eq(&self.reservation.connection, state)
    }
}

impl FrameCreditHandle {
    pub fn reserved_bytes(&self) -> usize {
        self.reservation.reserved_bytes
    }
}

fn reserve_send_on(
    state: &Arc<ConnectionState>,
    budget: &FrameBudget,
    body_capacity: usize,
) -> Result<ReservedFrameSend, WireError> {
    if state.is_poisoned() {
        return Err(WireError::ConnectionPoisoned);
    }
    if body_capacity > MAX_FRAME_BYTES {
        return Err(WireError::FrameTooLarge);
    }
    let reserved_bytes = body_capacity
        .checked_add(4)
        .ok_or(WireError::FrameTooLarge)?;
    let permit = budget.reserve(reserved_bytes)?;
    Ok(ReservedFrameSend {
        reservation: Arc::new(FrameReservation {
            _permit: permit,
            connection: state.clone(),
            reserved_bytes,
            body_capacity,
        }),
    })
}

async fn send_reserved_to<W: AsyncWrite + Unpin>(
    writer: &Mutex<W>,
    state: Arc<ConnectionState>,
    token: ReservedFrameSend,
    body: &[u8],
) -> Result<(), WireError> {
    if !token.belongs_to(&state) {
        return Err(WireError::WrongConnection);
    }
    if body.len() > token.body_capacity() {
        return Err(WireError::ReservationTooSmall);
    }
    if body.len() > MAX_FRAME_BYTES {
        return Err(WireError::FrameTooLarge);
    }
    if state.is_poisoned() {
        return Err(WireError::ConnectionPoisoned);
    }
    let mut writer = writer.lock().await;
    if state.is_poisoned() {
        return Err(WireError::ConnectionPoisoned);
    }
    write_frame(&mut *writer, body, state).await
}

pub struct VerifiedPipe {
    reader: Mutex<ReadHalf<PipeStream>>,
    writer: Mutex<WriteHalf<PipeStream>>,
    budget: FrameBudget,
    server: VerifiedProcess,
    client: Option<VerifiedProcess>,
    state: Arc<ConnectionState>,
    _connection: ConnectionPermit,
}

struct ReadyConnection {
    pipe: NamedPipeServer,
    client: Option<VerifiedProcess>,
    connection: ConnectionPermit,
}

pub struct PipeServer {
    name: String,
    pending: Option<NamedPipeServer>,
    ready: VecDeque<ReadyConnection>,
    budget: FrameBudget,
    identity: ProcessIdentity,
    #[cfg(test)]
    replacement_failures: usize,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct OwnerAuth {
    credential: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AuthResult {
    authenticated: bool,
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
    let mut buffer = vec![0; needed as usize];
    if GetTokenInformation(
        token,
        TokenUser,
        buffer.as_mut_ptr().cast(),
        needed,
        &mut needed,
    ) == 0
    {
        CloseHandle(token);
        return Err(WireError::Io);
    }
    let sid = (*(buffer.as_ptr() as *const TOKEN_USER)).User.Sid;
    let mut text = ptr::null_mut();
    if ConvertSidToStringSidW(sid, &mut text) == 0 {
        CloseHandle(token);
        return Err(WireError::Io);
    }
    let mut length = 0;
    while *text.add(length) != 0 {
        length += 1;
    }
    let out = String::from_utf16_lossy(std::slice::from_raw_parts(text, length));
    let _ = LocalFree(text.cast());
    CloseHandle(token);
    Ok(out)
}

fn create_server(name: &str, first: bool) -> Result<NamedPipeServer, WireError> {
    unsafe {
        let sddl: Vec<u16> = format!("D:P(A;;GA;;;{})\0", current_sid()?)
            .encode_utf16()
            .collect();
        let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            ptr::null_mut(),
        ) == 0
        {
            return Err(WireError::Io);
        }
        let mut attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let mut options = ServerOptions::new();
        options
            .first_pipe_instance(first)
            .reject_remote_clients(true);
        let result = options
            .create_with_security_attributes_raw(name, ptr::addr_of_mut!(attributes).cast())
            .map_err(|_| WireError::Io)
            .and_then(|server| {
                verify_noninheritable(server.as_raw_handle() as HANDLE)?;
                Ok(server)
            });
        let _ = LocalFree(descriptor);
        result
    }
}

fn capture_client(pipe: &NamedPipeServer) -> Option<VerifiedProcess> {
    let mut pid = 0;
    if unsafe { GetNamedPipeClientProcessId(pipe.as_raw_handle() as HANDLE, &mut pid) } == 0
        || pid == 0
    {
        return None;
    }
    let client = VerifiedProcess::open(pid).ok()?;
    if client.is_alive().ok()? {
        Some(client)
    } else {
        None
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
            ready: VecDeque::new(),
            budget,
            identity,
            #[cfg(test)]
            replacement_failures: 0,
        })
    }

    pub fn identity(&self) -> ProcessIdentity {
        self.identity
    }

    fn create_replacement(&mut self) -> Result<NamedPipeServer, WireError> {
        #[cfg(test)]
        if self.replacement_failures > 0 {
            self.replacement_failures -= 1;
            return Err(WireError::Transient);
        }
        create_server(&self.name, false).map_err(|_| WireError::Transient)
    }

    #[cfg(test)]
    fn fail_next_replacement(&mut self) {
        self.replacement_failures += 1;
    }

    fn take_ready(&mut self) -> Result<VerifiedPipe, WireError> {
        let ready = self.ready.pop_front().ok_or(WireError::Transient)?;
        let client = ready.client.ok_or(WireError::ClientIdentityUnavailable)?;
        let server = VerifiedProcess::verify(self.identity).map_err(|_| WireError::Io)?;
        Ok(VerifiedPipe::from_stream(
            PipeStream::Server(ready.pipe),
            self.budget.clone(),
            server,
            Some(client),
            ready.connection,
        ))
    }

    pub async fn accept(&mut self) -> Result<VerifiedPipe, WireError> {
        if !self.ready.is_empty() {
            if self.pending.is_none() {
                self.pending = Some(self.create_replacement()?);
            }
            return self.take_ready();
        }

        let connection = self.budget.reserve_connection()?;
        let pending = self.pending.as_ref().ok_or(WireError::Transient)?;
        if pending.connect().await.is_err() {
            let _ = pending.disconnect();
            return Err(WireError::Transient);
        }
        let connected = self.pending.take().ok_or(WireError::Transient)?;
        self.ready.push_back(ReadyConnection {
            client: capture_client(&connected),
            pipe: connected,
            connection,
        });
        self.pending = Some(self.create_replacement()?);
        self.take_ready()
    }
}

impl VerifiedPipe {
    fn from_stream(
        stream: PipeStream,
        budget: FrameBudget,
        server: VerifiedProcess,
        client: Option<VerifiedProcess>,
        connection: ConnectionPermit,
    ) -> Self {
        let (reader, writer) = split(stream);
        Self {
            reader: Mutex::new(reader),
            writer: Mutex::new(writer),
            budget,
            server,
            client,
            state: ConnectionState::new(),
            _connection: connection,
        }
    }

    pub async fn connect(name: &str, expected: ProcessIdentity) -> Result<Self, WireError> {
        Self::connect_with_options(name, expected, TransportOptions::default()).await
    }

    pub async fn connect_with_options(
        name: &str,
        expected: ProcessIdentity,
        options: TransportOptions,
    ) -> Result<Self, WireError> {
        if options.connect_timeout.is_zero() || options.connect_retry_interval.is_zero() {
            return Err(WireError::InvalidFrame);
        }
        let deadline = Instant::now() + options.connect_timeout;
        loop {
            match Self::try_connect(name, expected) {
                Err(WireError::PipeBusy) => {
                    let now = Instant::now();
                    if now >= deadline {
                        return Err(WireError::ConnectTimeout);
                    }
                    sleep(options.connect_retry_interval.min(deadline - now)).await;
                }
                result => return result,
            }
        }
    }

    fn try_connect(name: &str, expected: ProcessIdentity) -> Result<Self, WireError> {
        unsafe {
            let handle = CreateFileW(
                wide(OsStr::new(name)).as_ptr(),
                FILE_READ_DATA | FILE_WRITE_DATA,
                0,
                ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                ptr::null_mut(),
            );
            if handle == INVALID_HANDLE_VALUE {
                let error = GetLastError();
                return if error == ERROR_PIPE_BUSY {
                    Err(WireError::PipeBusy)
                } else {
                    Err(WireError::Native(error))
                };
            }
            if let Err(error) = verify_noninheritable(handle) {
                CloseHandle(handle);
                return Err(error);
            }
            let mut pid = 0;
            if GetNamedPipeServerProcessId(handle, &mut pid) == 0 {
                CloseHandle(handle);
                return Err(WireError::Io);
            }
            if pid != expected.pid {
                CloseHandle(handle);
                return Err(WireError::ServerIdentityMismatch);
            }
            let server = match VerifiedProcess::verify(expected) {
                Ok(server) if server.is_alive().unwrap_or(false) => server,
                Err(crate::ProcessError::Stale) => {
                    CloseHandle(handle);
                    return Err(WireError::ServerIdentityMismatch);
                }
                _ => {
                    CloseHandle(handle);
                    return Err(WireError::ServerIdentityUnavailable);
                }
            };
            let client = match NamedPipeClient::from_raw_handle(handle as RawHandle) {
                Ok(client) => client,
                Err(_) => {
                    CloseHandle(handle);
                    return Err(WireError::Io);
                }
            };
            let budget = FrameBudget::new(MAX_FRAME_BYTES * 2);
            let connection = budget.reserve_connection()?;
            Ok(Self::from_stream(
                PipeStream::Client(client),
                budget,
                server,
                None,
                connection,
            ))
        }
    }

    pub fn server_identity(&self) -> ProcessIdentity {
        self.server.identity()
    }

    pub fn connecting_client_identity(&self) -> Result<ProcessIdentity, WireError> {
        self.client
            .as_ref()
            .map(VerifiedProcess::identity)
            .ok_or(WireError::WrongEndpoint)
    }

    pub fn connecting_client_is_alive(&self) -> Result<bool, WireError> {
        self.client
            .as_ref()
            .ok_or(WireError::WrongEndpoint)?
            .is_alive()
            .map_err(|_| WireError::ClientIdentityUnavailable)
    }

    pub fn is_poisoned(&self) -> bool {
        self.state.is_poisoned()
    }

    pub fn reserve_send(&self, body_capacity: usize) -> Result<ReservedFrameSend, WireError> {
        reserve_send_on(&self.state, &self.budget, body_capacity)
    }

    pub async fn send_reserved(
        &self,
        token: ReservedFrameSend,
        body: &[u8],
    ) -> Result<(), WireError> {
        send_reserved_to(&self.writer, self.state.clone(), token, body).await
    }

    pub async fn send_bytes(&self, bytes: &[u8]) -> Result<(), WireError> {
        let token = self.reserve_send(bytes.len())?;
        self.send_reserved(token, bytes).await
    }

    pub async fn send_request(&self, request: &RequestEnvelope) -> Result<(), WireError> {
        self.send_bytes(&encode_message_body(request)?).await
    }

    pub async fn send_response(&self, response: &ResponseEnvelope) -> Result<(), WireError> {
        self.send_bytes(&encode_message_body(response)?).await
    }

    /// Receives one length-prefixed frame while retaining its byte credit.
    ///
    /// `Capacity` and `FrameTooLarge` occur after the prefix has been consumed,
    /// so they poison this connection. They do not imply application rollback.
    pub async fn recv_bytes(&self) -> Result<ReceivedFrame, WireError> {
        if self.state.is_poisoned() {
            return Err(WireError::ConnectionPoisoned);
        }
        let mut reader = self.reader.lock().await;
        if self.state.is_poisoned() {
            return Err(WireError::ConnectionPoisoned);
        }
        read_frame(&mut *reader, &self.budget, self.state.clone()).await
    }

    pub async fn recv_request(&self) -> Result<RequestEnvelope, WireError> {
        let frame = self.recv_bytes().await?;
        decode_body(frame.as_ref())
    }

    pub async fn recv_response(&self) -> Result<ResponseEnvelope, WireError> {
        let frame = self.recv_bytes().await?;
        decode_body(frame.as_ref())
    }

    pub async fn authenticate_peer(&self, boot_id: &str) -> Result<(), WireError> {
        self.authenticate_peer_with_timeout(boot_id, DEFAULT_HANDSHAKE_TIMEOUT)
            .await
    }

    pub async fn authenticate_peer_with_timeout(
        &self,
        boot_id: &str,
        deadline: Duration,
    ) -> Result<(), WireError> {
        if self.client.is_none() {
            return Err(WireError::WrongEndpoint);
        }
        run_handshake_deadline(self, deadline, self.authenticate_peer_inner(boot_id)).await
    }

    async fn authenticate_peer_inner(&self, boot_id: &str) -> Result<(), WireError> {
        if !valid_id(boot_id) {
            return Err(WireError::InvalidFrame);
        }
        let request = self.recv_request().await?;
        let accepted =
            request.correlation_id() == boot_id && request.hello_payload().boot_id() == boot_id;
        self.send_response(&ResponseEnvelope::new(request.correlation_id(), accepted))
            .await?;
        if accepted {
            Ok(())
        } else {
            self.state.poison();
            Err(WireError::AuthenticationRejected)
        }
    }

    /// Authenticates an owner after the versioned typed boot hello.
    ///
    /// The credential and acceptance frames form a strict private raw-JSON
    /// transport phase; they are not RPC `RequestEnvelope`/`ResponseEnvelope`
    /// messages. Either side may use the timeout variant to override the
    /// default bounded handshake deadline.
    pub async fn authenticate_owner(
        &self,
        boot_id: &str,
        credential: &OwnerCredential,
    ) -> Result<(), WireError> {
        self.authenticate_owner_with_timeout(boot_id, credential, DEFAULT_HANDSHAKE_TIMEOUT)
            .await
    }

    pub async fn authenticate_owner_with_timeout(
        &self,
        boot_id: &str,
        credential: &OwnerCredential,
        deadline: Duration,
    ) -> Result<(), WireError> {
        if self.client.is_none() {
            return Err(WireError::WrongEndpoint);
        }
        run_handshake_deadline(
            self,
            deadline,
            self.authenticate_owner_inner(boot_id, credential),
        )
        .await
    }

    async fn authenticate_owner_inner(
        &self,
        boot_id: &str,
        credential: &OwnerCredential,
    ) -> Result<(), WireError> {
        self.authenticate_peer_inner(boot_id).await?;
        let auth_bytes = self.recv_bytes().await?;
        let auth: OwnerAuth = decode_json(auth_bytes.as_ref())?;
        let authenticated = credential.matches_bytes(&auth.decode()?);
        self.send_bytes(
            &serde_json::to_vec(&AuthResult { authenticated })
                .map_err(|_| WireError::InvalidFrame)?,
        )
        .await?;
        if authenticated {
            Ok(())
        } else {
            self.state.poison();
            Err(WireError::AuthenticationRejected)
        }
    }
}

async fn run_handshake_deadline<T>(
    pipe: &VerifiedPipe,
    deadline: Duration,
    operation: impl Future<Output = Result<T, WireError>>,
) -> Result<T, WireError> {
    if deadline.is_zero() {
        return Err(WireError::InvalidFrame);
    }
    match timeout(deadline, operation).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => {
            pipe.state.poison();
            Err(error)
        }
        Err(_) => {
            pipe.state.poison();
            Err(WireError::HandshakeTimeout)
        }
    }
}

async fn write_frame<W: AsyncWrite + Unpin>(
    writer: &mut W,
    bytes: &[u8],
    state: Arc<ConnectionState>,
) -> Result<(), WireError> {
    if state.is_poisoned() {
        return Err(WireError::ConnectionPoisoned);
    }
    let prefix = (bytes.len() as u32).to_le_bytes();
    let mut progress = ProgressGuard::new(state.clone());
    progress.start();
    let io = async {
        writer.write_all(&prefix).await.map_err(map_io)?;
        writer.write_all(bytes).await.map_err(map_io)?;
        writer.flush().await.map_err(map_io)
    };
    let result = tokio::select! {
        biased;
        _ = state.wait_until_poisoned() => Err(WireError::ConnectionPoisoned),
        result = io => result,
    };
    if result.is_ok() {
        progress.complete();
    }
    result
}

async fn read_frame<R: AsyncRead + Unpin>(
    reader: &mut R,
    budget: &FrameBudget,
    state: Arc<ConnectionState>,
) -> Result<ReceivedFrame, WireError> {
    if state.is_poisoned() {
        return Err(WireError::ConnectionPoisoned);
    }
    let mut progress = ProgressGuard::new(state.clone());
    progress.start();
    let io = async {
        let mut prefix = [0; 4];
        reader.read_exact(&mut prefix).await.map_err(map_io)?;
        let length = u32::from_le_bytes(prefix) as usize;
        if length > MAX_FRAME_BYTES {
            return Err(WireError::FrameTooLarge);
        }
        let permit = budget.reserve(length + 4)?;
        let mut bytes = vec![0; length];
        reader.read_exact(&mut bytes).await.map_err(map_io)?;
        Ok(ReceivedFrame {
            bytes,
            _permit: permit,
        })
    };
    let result = tokio::select! {
        biased;
        _ = state.wait_until_poisoned() => Err(WireError::ConnectionPoisoned),
        result = io => result,
    };
    if result.is_ok() {
        progress.complete();
    }
    result
}

fn map_io(error: std::io::Error) -> WireError {
    if matches!(
        error.kind(),
        std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::UnexpectedEof
    ) {
        WireError::Disconnected
    } else {
        WireError::Io
    }
}

async fn hello(pipe: &VerifiedPipe, discovery: &DiscoveryRecord) -> Result<(), WireError> {
    if !discovery.validate() {
        return Err(WireError::InvalidFrame);
    }
    pipe.send_request(&RequestEnvelope::hello(
        discovery.boot_id.clone(),
        crate::Hello::new(discovery.boot_id.clone()),
    ))
    .await?;
    let response = pipe.recv_response().await?;
    if response.correlation_id() != discovery.boot_id || !response.accepted() {
        pipe.state.poison();
        return Err(WireError::AuthenticationRejected);
    }
    Ok(())
}

pub(crate) async fn connect_owner(
    discovery: &DiscoveryRecord,
    credential: &OwnerCredential,
    options: TransportOptions,
) -> Result<VerifiedPipe, WireError> {
    let pipe =
        VerifiedPipe::connect_with_options(&discovery.pipe_name, discovery.server, options).await?;
    let handshake = async {
        hello(&pipe, discovery).await?;
        pipe.send_bytes(
            &serde_json::to_vec(&OwnerAuth {
                credential: STANDARD.encode(credential.bytes()),
            })
            .map_err(|_| WireError::InvalidFrame)?,
        )
        .await?;
        let result_bytes = pipe.recv_bytes().await?;
        let result: AuthResult = decode_json(result_bytes.as_ref())?;
        if result.authenticated {
            Ok(())
        } else {
            pipe.state.poison();
            Err(WireError::AuthenticationRejected)
        }
    };
    run_handshake_deadline(&pipe, options.handshake_timeout, handshake).await?;
    Ok(pipe)
}

pub(crate) async fn connect_peer(
    discovery: &DiscoveryRecord,
    options: TransportOptions,
) -> Result<VerifiedPipe, WireError> {
    let pipe =
        VerifiedPipe::connect_with_options(&discovery.pipe_name, discovery.server, options).await?;
    run_handshake_deadline(&pipe, options.handshake_timeout, hello(&pipe, discovery)).await?;
    Ok(pipe)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs, io,
        sync::atomic::{AtomicUsize, Ordering as AtomicOrdering},
        task::Waker,
        time::{SystemTime, UNIX_EPOCH},
    };
    use tokio::sync::oneshot;

    fn pipe_name(label: &str) -> String {
        format!(
            r"\\.\pipe\termx-swarm-unit-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )
    }

    fn retained(label: &str) -> std::path::PathBuf {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../retired/test-artifacts/swarm-client")
            .join(format!(
                "{label}-{}",
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[tokio::test]
    async fn cancelled_accept_and_failed_replacement_preserve_first_instance() {
        let evidence = retained("accept-cancellation-recovery");
        let name = pipe_name("accept-recovery");
        let budget = FrameBudget::new(1024);
        let mut server = PipeServer::bind(&name, budget).unwrap();
        assert!(timeout(Duration::from_millis(20), server.accept())
            .await
            .is_err());
        assert!(PipeServer::bind(&name, FrameBudget::new(1024)).is_err());

        let client = VerifiedPipe::connect(&name, server.identity())
            .await
            .unwrap();
        server.fail_next_replacement();
        assert!(matches!(server.accept().await, Err(WireError::Transient)));
        assert!(PipeServer::bind(&name, FrameBudget::new(1024)).is_err());
        let accepted = server.accept().await.unwrap();
        assert_eq!(
            accepted.connecting_client_identity().unwrap().pid,
            std::process::id()
        );
        drop(accepted);
        drop(client);
        fs::write(
            evidence.join("result.json"),
            br#"{"cancelled_accept_retained_first_instance":true,"replacement_failure_retained_connected_instance":true,"later_accept_progressed":true}"#,
        )
        .unwrap();
    }

    struct PartialReader {
        stage: usize,
        partial: Option<oneshot::Sender<()>>,
    }

    impl AsyncRead for PartialReader {
        fn poll_read(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            buffer: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            match self.stage {
                0 => {
                    buffer.put_slice(&4u32.to_le_bytes());
                    self.stage = 1;
                    Poll::Ready(Ok(()))
                }
                1 => {
                    buffer.put_slice(b"ab");
                    self.stage = 2;
                    if let Some(signal) = self.partial.take() {
                        let _ = signal.send(());
                    }
                    Poll::Ready(Ok(()))
                }
                _ => Poll::Pending,
            }
        }
    }

    struct PartialWriter {
        stage: usize,
        bytes: Arc<AtomicUsize>,
        partial: Option<oneshot::Sender<()>>,
        waker: Option<Waker>,
    }

    struct PrefixPartialReader {
        partial: Option<oneshot::Sender<()>>,
        wrote_prefix_bytes: bool,
    }

    impl AsyncRead for PrefixPartialReader {
        fn poll_read(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            buffer: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            if !self.wrote_prefix_bytes {
                buffer.put_slice(&4u32.to_le_bytes()[..2]);
                self.wrote_prefix_bytes = true;
                if let Some(signal) = self.partial.take() {
                    let _ = signal.send(());
                }
                Poll::Ready(Ok(()))
            } else {
                Poll::Pending
            }
        }
    }

    struct PrefixPartialWriter {
        partial: Option<oneshot::Sender<()>>,
        wrote_prefix_bytes: bool,
    }

    impl AsyncWrite for PrefixPartialWriter {
        fn poll_write(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            _buffer: &[u8],
        ) -> Poll<io::Result<usize>> {
            if !self.wrote_prefix_bytes {
                self.wrote_prefix_bytes = true;
                if let Some(signal) = self.partial.take() {
                    let _ = signal.send(());
                }
                Poll::Ready(Ok(2))
            } else {
                Poll::Pending
            }
        }

        fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }

        fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    impl AsyncWrite for PartialWriter {
        fn poll_write(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buffer: &[u8],
        ) -> Poll<io::Result<usize>> {
            match self.stage {
                0 => {
                    self.stage = 1;
                    self.bytes.fetch_add(buffer.len(), AtomicOrdering::Relaxed);
                    Poll::Ready(Ok(buffer.len()))
                }
                1 => {
                    self.stage = 2;
                    self.bytes.fetch_add(2, AtomicOrdering::Relaxed);
                    if let Some(signal) = self.partial.take() {
                        let _ = signal.send(());
                    }
                    Poll::Ready(Ok(2))
                }
                _ => {
                    self.waker = Some(cx.waker().clone());
                    Poll::Pending
                }
            }
        }

        fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }

        fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn partial_read_and_write_cancellation_poison_both_directions() {
        let evidence = retained("partial-io-cancellation");

        let prefix_read_state = ConnectionState::new();
        let prefix_read_budget = FrameBudget::new(1024);
        let (prefix_read_signal, prefix_read_partial) = oneshot::channel();
        let mut prefix_reader = PrefixPartialReader {
            partial: Some(prefix_read_signal),
            wrote_prefix_bytes: false,
        };
        let mut prefix_read = Box::pin(read_frame(
            &mut prefix_reader,
            &prefix_read_budget,
            prefix_read_state.clone(),
        ));
        tokio::select! {
            _ = prefix_read_partial => {}
            _ = &mut prefix_read => panic!("partial-prefix reader unexpectedly completed"),
        }
        drop(prefix_read);
        assert!(prefix_read_state.is_poisoned());
        assert_eq!(prefix_read_budget.usage(), (0, 0));

        let prefix_write_state = ConnectionState::new();
        let (prefix_write_signal, prefix_write_partial) = oneshot::channel();
        let mut prefix_writer = PrefixPartialWriter {
            partial: Some(prefix_write_signal),
            wrote_prefix_bytes: false,
        };
        let mut prefix_write = Box::pin(write_frame(
            &mut prefix_writer,
            b"four",
            prefix_write_state.clone(),
        ));
        tokio::select! {
            _ = prefix_write_partial => {}
            result = &mut prefix_write => panic!("partial-prefix writer unexpectedly completed: {result:?}"),
        }
        drop(prefix_write);
        assert!(prefix_write_state.is_poisoned());

        let read_state = ConnectionState::new();
        let read_budget = FrameBudget::new(1024);
        let (read_signal, read_partial) = oneshot::channel();
        let mut reader = PartialReader {
            stage: 0,
            partial: Some(read_signal),
        };
        let mut read = Box::pin(read_frame(&mut reader, &read_budget, read_state.clone()));
        tokio::select! {
            _ = read_partial => {}
            _ = &mut read => panic!("partial reader unexpectedly completed"),
        }
        drop(read);
        assert!(read_state.is_poisoned());
        assert_eq!(read_budget.usage(), (0, 0));
        assert!(matches!(
            read_frame(&mut tokio::io::empty(), &read_budget, read_state.clone()).await,
            Err(WireError::ConnectionPoisoned)
        ));

        let write_state = ConnectionState::new();
        let written = Arc::new(AtomicUsize::new(0));
        let (write_signal, write_partial) = oneshot::channel();
        let mut writer = PartialWriter {
            stage: 0,
            bytes: written.clone(),
            partial: Some(write_signal),
            waker: None,
        };
        let mut write = Box::pin(write_frame(&mut writer, b"four", write_state.clone()));
        tokio::select! {
            _ = write_partial => {}
            result = &mut write => panic!("partial writer unexpectedly completed: {result:?}"),
        }
        drop(write);
        assert_eq!(written.load(AtomicOrdering::Relaxed), 6);
        assert!(write_state.is_poisoned());
        assert!(matches!(
            write_frame(&mut tokio::io::sink(), b"next", write_state.clone()).await,
            Err(WireError::ConnectionPoisoned)
        ));
        fs::write(
            evidence.join("result.json"),
            br#"{"partial_prefix_read_cancelled":true,"partial_prefix_write_cancelled":true,"partial_body_read_cancelled":true,"partial_body_write_cancelled":true,"all_connections_poisoned":true,"frame_credit_released":true}"#,
        )
        .unwrap();
    }

    #[tokio::test]
    async fn post_prefix_capacity_and_oversize_are_connection_fatal() {
        let evidence = retained("post-prefix-fatal");
        for (length, limit, expected) in [
            (100u32, 32usize, WireError::Capacity),
            (
                MAX_FRAME_BYTES as u32 + 1,
                MAX_FRAME_BYTES + 4,
                WireError::FrameTooLarge,
            ),
        ] {
            let state = ConnectionState::new();
            let budget = FrameBudget::new(limit);
            let mut input = &length.to_le_bytes()[..];
            match read_frame(&mut input, &budget, state.clone()).await {
                Err(error) => assert_eq!(error, expected),
                Ok(_) => panic!("post-prefix failure unexpectedly produced a frame"),
            }
            assert!(state.is_poisoned());
            assert!(matches!(
                read_frame(&mut tokio::io::empty(), &budget, state).await,
                Err(WireError::ConnectionPoisoned)
            ));
            assert_eq!(budget.usage(), (0, 0));
        }
        fs::write(
            evidence.join("result.json"),
            br#"{"post_prefix_capacity_fatal":true,"post_prefix_oversize_fatal":true,"residual_bytes_not_reinterpreted":true}"#,
        )
        .unwrap();
    }

    #[tokio::test]
    async fn unpolled_frame_future_does_not_poison() {
        let state = ConnectionState::new();
        let mut writer = tokio::io::sink();
        let future = write_frame(&mut writer, b"never-polled", state.clone());
        drop(future);
        assert!(!state.is_poisoned());
        write_frame(&mut writer, b"later", state.clone())
            .await
            .unwrap();
        assert!(!state.is_poisoned());
    }

    #[tokio::test]
    async fn cancellation_while_waiting_for_direction_lock_does_not_poison() {
        let name = pipe_name("lock-wait-cancel");
        let mut server = PipeServer::bind(&name, FrameBudget::new(1024)).unwrap();
        let client = VerifiedPipe::connect(&name, server.identity())
            .await
            .unwrap();
        let accepted = server.accept().await.unwrap();

        let lock = accepted.writer.lock().await;
        let blocked = accepted.send_bytes(b"not-started");
        assert!(timeout(Duration::from_millis(20), blocked).await.is_err());
        assert!(!accepted.is_poisoned());
        drop(lock);

        accepted.send_bytes(b"progress").await.unwrap();
        assert_eq!(client.recv_bytes().await.unwrap().as_ref(), b"progress");
        assert!(!accepted.is_poisoned());
    }

    #[tokio::test]
    async fn reserved_send_cancel_while_waiting_for_writer_does_not_poison() {
        let evidence = retained("reserved-send-lock-wait-cancel");
        let name = pipe_name("reserved-lock-wait");
        let budget = FrameBudget::new(1024);
        let mut server = PipeServer::bind(&name, budget.clone()).unwrap();
        let client = VerifiedPipe::connect(&name, server.identity())
            .await
            .unwrap();
        let accepted = server.accept().await.unwrap();
        let lock = accepted.writer.lock().await;
        let token = accepted.reserve_send(4).unwrap();
        let handle = token.credit_handle();
        assert_eq!(budget.usage(), (8, 1));
        let blocked = accepted.send_reserved(token, b"abcd");
        assert!(timeout(Duration::from_millis(20), blocked).await.is_err());
        assert!(!accepted.is_poisoned());
        assert_eq!(budget.usage(), (8, 1));
        drop(handle);
        assert_eq!(budget.usage(), (0, 0));
        drop(lock);
        accepted.send_bytes(b"progress").await.unwrap();
        assert_eq!(client.recv_bytes().await.unwrap().as_ref(), b"progress");
        assert!(!accepted.is_poisoned());
        fs::write(
            evidence.join("result.json"),
            br#"{"writer_wait_cancel_did_not_poison":true,"later_send_progressed":true}"#,
        )
        .unwrap();
    }

    #[tokio::test]
    async fn reserved_send_partial_write_cancellation_poisons() {
        let evidence = retained("reserved-send-partial-write");
        let state = ConnectionState::new();
        let budget = FrameBudget::new(1024);
        let token = reserve_send_on(&state, &budget, 4).unwrap();
        let extra = reserve_send_on(&state, &budget, 1).unwrap();
        let handle = token.credit_handle();
        assert_eq!(budget.usage(), (13, 2));
        let written = Arc::new(AtomicUsize::new(0));
        let (write_signal, write_partial) = oneshot::channel();
        let writer = Mutex::new(PartialWriter {
            stage: 0,
            bytes: written.clone(),
            partial: Some(write_signal),
            waker: None,
        });
        let mut write = Box::pin(send_reserved_to(&writer, state.clone(), token, b"four"));
        tokio::select! {
            _ = write_partial => {}
            result = &mut write => panic!("partial reserved writer unexpectedly completed: {result:?}"),
        }
        drop(write);
        assert_eq!(written.load(AtomicOrdering::Relaxed), 6);
        assert!(state.is_poisoned());
        assert_eq!(budget.usage(), (13, 2));
        let extra_writer = Mutex::new(tokio::io::sink());
        assert!(matches!(
            send_reserved_to(&extra_writer, state.clone(), extra, b"x").await,
            Err(WireError::ConnectionPoisoned)
        ));
        drop(handle);
        assert_eq!(budget.usage(), (0, 0));
        assert!(matches!(
            reserve_send_on(&state, &budget, 1),
            Err(WireError::ConnectionPoisoned)
        ));
        fs::write(
            evidence.join("result.json"),
            br#"{"partial_reserved_write_cancelled":true,"connection_poisoned":true,"credit_held_until_handle_drop":true}"#,
        )
        .unwrap();
    }

    #[test]
    fn reserved_send_credit_handle_is_clone_positive_control() {
        fn clone_handle(handle: FrameCreditHandle) -> (FrameCreditHandle, FrameCreditHandle) {
            (handle.clone(), handle)
        }
        let state = ConnectionState::new();
        let budget = FrameBudget::new(1024);
        let token = reserve_send_on(&state, &budget, 2).unwrap();
        let (first, second) = clone_handle(token.credit_handle());
        assert_eq!(first.reserved_bytes(), 6);
        assert_eq!(second.reserved_bytes(), 6);
        assert_eq!(budget.usage(), (6, 1));
        drop(token);
        drop(first);
        assert_eq!(budget.usage(), (6, 1));
        drop(second);
        assert_eq!(budget.usage(), (0, 0));
    }
}
