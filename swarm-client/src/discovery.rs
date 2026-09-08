//! Discovery document publication and bootstrap reads.
//!
//! Ordinary readers (`AuthorityClaim::read_discovery`, `ClientBootstrap::
//! read_discovery`) accept exactly the current version 2 schema. The
//! exclusive publisher has a separate recognition path: a secure current
//! object must be either an exact legacy version 1 document or a version 2
//! document before it may be replaced, and its exact bytes are retired once
//! under a unique `retired` path by the atomic replacement itself. Malformed,
//! insecure, future, unknown-version and wrong-type objects stay unchanged and
//! block publication. Transient sharing violations from short-lived readers
//! are retried with a bounded backoff that revalidates the same prerequisites.
use crate::{
    security::{create_private_discovery, open_private_discovery},
    wire::valid_id,
    AuthorityClaim, AuthorityError, ClientBootstrap, DiscoveryRecord, ProcessIdentity,
    DISCOVERY_VERSION,
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::{
    ffi::OsStr,
    fs,
    io::{Read, Write},
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
    ptr,
    time::Duration,
};
use windows_sys::Win32::Storage::FileSystem::{
    MoveFileExW, ReplaceFileW, MOVEFILE_WRITE_THROUGH, REPLACEFILE_WRITE_THROUGH,
};

const MAX_DISCOVERY_BYTES: u64 = 64 * 1024;
/// Bounded retry for transient sharing violations while a short-lived reader
/// holds the current object without delete sharing. Total wait is well under
/// five seconds; a longer holder yields `AuthorityError::Contended`.
const PUBLISH_RETRY_ATTEMPTS: u32 = 20;
const PUBLISH_RETRY_STEP: Duration = Duration::from_millis(20);
const PUBLISH_RETRY_MAX_BACKOFF: Duration = Duration::from_millis(150);

const ERROR_FILE_EXISTS: i32 = 80;
const ERROR_SHARING_VIOLATION: i32 = 32;
const ERROR_LOCK_VIOLATION: i32 = 33;
const ERROR_ALREADY_EXISTS: i32 = 183;
const ERROR_UNABLE_TO_REMOVE_REPLACED: i32 = 1175;

fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}

/// Version probe used before strict decoding so that a future document with
/// unknown fields is reported as future rather than malformed.
#[derive(Deserialize)]
struct VersionProbe {
    version: u16,
}

/// Exact legacy version 1 schema (one shared endpoint). Recognized only by
/// the exclusive publisher for preserved migration; never returned to a
/// bootstrap reader.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct LegacyDiscoveryV1 {
    version: u16,
    authority_id: String,
    boot_id: String,
    server: ProcessIdentity,
    pipe_name: String,
}

impl LegacyDiscoveryV1 {
    fn validate(&self) -> bool {
        self.version == 1
            && valid_id(&self.authority_id)
            && valid_id(&self.boot_id)
            && self.server.pid != 0
            && self.server.creation_filetime.get() != 0
            && crate::wire::valid_pipe_name(&self.pipe_name)
    }
}

enum Predecessor {
    Current,
    Legacy,
}

fn probe_version(bytes: &[u8]) -> Result<u16, AuthorityError> {
    serde_json::from_slice::<VersionProbe>(bytes)
        .map(|probe| probe.version)
        .map_err(|_| AuthorityError::InvalidDiscovery)
}

fn classify(record: DiscoveryRecord) -> Result<DiscoveryRecord, AuthorityError> {
    if record.version > DISCOVERY_VERSION {
        return Err(AuthorityError::FutureDiscovery);
    }
    if !record.validate() {
        return Err(AuthorityError::InvalidDiscovery);
    }
    Ok(record)
}

/// Ordinary reader classification: exactly version 2, strict schema.
fn classify_bytes(bytes: &[u8]) -> Result<DiscoveryRecord, AuthorityError> {
    if probe_version(bytes)? > DISCOVERY_VERSION {
        return Err(AuthorityError::FutureDiscovery);
    }
    classify(serde_json::from_slice(bytes).map_err(|_| AuthorityError::InvalidDiscovery)?)
}

/// Publisher-only recognition of a replaceable predecessor.
fn recognize_predecessor(bytes: &[u8]) -> Result<Predecessor, AuthorityError> {
    match probe_version(bytes)? {
        version if version > DISCOVERY_VERSION => Err(AuthorityError::FutureDiscovery),
        DISCOVERY_VERSION => classify_bytes(bytes).map(|_| Predecessor::Current),
        1 => {
            let legacy: LegacyDiscoveryV1 =
                serde_json::from_slice(bytes).map_err(|_| AuthorityError::InvalidDiscovery)?;
            if legacy.validate() {
                Ok(Predecessor::Legacy)
            } else {
                Err(AuthorityError::InvalidDiscovery)
            }
        }
        _ => Err(AuthorityError::InvalidDiscovery),
    }
}

fn read_current_bytes(path: &Path) -> Result<Vec<u8>, AuthorityError> {
    let file = open_private_discovery(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > MAX_DISCOVERY_BYTES {
        return Err(AuthorityError::InvalidDiscovery);
    }
    read_bounded(file, metadata.len())
}

fn read(path: &Path) -> Result<DiscoveryRecord, AuthorityError> {
    classify_bytes(&read_current_bytes(path)?)
}

fn read_bounded<R: Read>(reader: R, observed_len: u64) -> Result<Vec<u8>, AuthorityError> {
    if observed_len > MAX_DISCOVERY_BYTES {
        return Err(AuthorityError::InvalidDiscovery);
    }
    let mut bytes = Vec::with_capacity(observed_len as usize);
    reader
        .take(MAX_DISCOVERY_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_DISCOVERY_BYTES {
        return Err(AuthorityError::InvalidDiscovery);
    }
    Ok(bytes)
}

fn unique_sibling(root: &Path, prefix: &str) -> PathBuf {
    loop {
        let mut nonce = [0u8; 8];
        rand::rngs::OsRng.fill_bytes(&mut nonce);
        let path = root.join(format!(
            "{prefix}.{}.{}",
            std::process::id(),
            u64::from_le_bytes(nonce)
        ));
        if !path.exists() {
            return path;
        }
    }
}

/// Reads and recognizes the current object. `Ok(None)` means no current
/// object exists; every other failure blocks publication unchanged.
fn recognize_current(current: &Path) -> Result<Option<Predecessor>, AuthorityError> {
    match read_current_bytes(current) {
        Ok(bytes) => recognize_predecessor(&bytes).map(Some),
        Err(AuthorityError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

enum Swap {
    Done,
    /// Native failure code from the atomic swap; the predecessor and the
    /// pending object both keep their names.
    Failed(i32),
}

fn swap_in(current: &Path, pending: &Path, retired_root: &Path, replacing: bool) -> Swap {
    let ok = if replacing {
        let backup = unique_sibling(retired_root, "discovery.json");
        unsafe {
            ReplaceFileW(
                wide(current.as_os_str()).as_ptr(),
                wide(pending.as_os_str()).as_ptr(),
                wide(backup.as_os_str()).as_ptr(),
                REPLACEFILE_WRITE_THROUGH,
                ptr::null(),
                ptr::null(),
            )
        }
    } else {
        unsafe {
            MoveFileExW(
                wide(pending.as_os_str()).as_ptr(),
                wide(current.as_os_str()).as_ptr(),
                MOVEFILE_WRITE_THROUGH,
            )
        }
    };
    if ok == 0 {
        Swap::Failed(std::io::Error::last_os_error().raw_os_error().unwrap_or(0))
    } else {
        Swap::Done
    }
}

fn retryable(code: i32) -> bool {
    matches!(
        code,
        ERROR_SHARING_VIOLATION
            | ERROR_LOCK_VIOLATION
            | ERROR_UNABLE_TO_REMOVE_REPLACED
            | ERROR_ALREADY_EXISTS
            | ERROR_FILE_EXISTS
    )
}

/// Our own unpublished pending object is moved aside, never deleted, so a
/// failed publication leaves nothing that looks like a current document.
fn retire_pending(pending: &Path, retired_root: &Path) {
    if fs::create_dir_all(retired_root).is_ok() {
        let target = unique_sibling(retired_root, "discovery.pending");
        let _ = fs::rename(pending, target);
    }
}

fn publish(root: &Path, record: &DiscoveryRecord) -> Result<(), AuthorityError> {
    classify(record.clone())?;
    let bytes = serde_json::to_vec(record).map_err(|_| AuthorityError::InvalidDiscovery)?;
    if bytes.len() as u64 > MAX_DISCOVERY_BYTES {
        return Err(AuthorityError::InvalidDiscovery);
    }

    let current = root.join("discovery.json");
    let retired_root = root.join("retired");
    let mut replacing = recognize_current(&current)?.is_some();

    let pending = unique_sibling(root, "discovery.pending");
    let mut output = create_private_discovery(&pending)?;
    output.write_all(&bytes)?;
    output.sync_all()?;
    drop(output);

    let mut attempt = 0;
    loop {
        if replacing {
            fs::create_dir_all(&retired_root)?;
        }
        match swap_in(&current, &pending, &retired_root, replacing) {
            Swap::Done => return Ok(()),
            Swap::Failed(code) if retryable(code) => {
                if attempt >= PUBLISH_RETRY_ATTEMPTS {
                    retire_pending(&pending, &retired_root);
                    return Err(AuthorityError::Contended);
                }
                attempt += 1;
                std::thread::sleep((PUBLISH_RETRY_STEP * attempt).min(PUBLISH_RETRY_MAX_BACKOFF));
                // Revalidate the same prerequisites: the object we are about
                // to replace must still be a recognized secure predecessor.
                match recognize_current(&current) {
                    Ok(predecessor) => replacing = predecessor.is_some(),
                    Err(error) => {
                        retire_pending(&pending, &retired_root);
                        return Err(error);
                    }
                }
            }
            Swap::Failed(_) => {
                retire_pending(&pending, &retired_root);
                return Err(AuthorityError::Native);
            }
        }
    }
}

impl AuthorityClaim {
    pub fn read_discovery(&self) -> Result<DiscoveryRecord, AuthorityError> {
        read(&self.root().join("discovery.json"))
    }

    /// Publishes version 2 discovery, replacing an exact secure legacy v1 or
    /// v2 predecessor atomically and retiring its exact bytes. See the
    /// module documentation for what blocks publication.
    pub fn publish_discovery(&self, record: &DiscoveryRecord) -> Result<(), AuthorityError> {
        publish(self.root(), record)
    }
}

impl ClientBootstrap {
    pub fn read_discovery(&self) -> Result<DiscoveryRecord, AuthorityError> {
        read(&self.root().join("discovery.json"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::Cell, io::Read, rc::Rc};

    struct CountingReader {
        bytes_read: Rc<Cell<usize>>,
    }

    impl Read for CountingReader {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            buffer.fill(b'x');
            self.bytes_read.set(self.bytes_read.get() + buffer.len());
            Ok(buffer.len())
        }
    }

    #[test]
    fn bounded_reader_stops_at_max_plus_one_when_object_grows_after_size_check() {
        let bytes_read = Rc::new(Cell::new(0));
        let result = read_bounded(
            CountingReader {
                bytes_read: bytes_read.clone(),
            },
            1,
        );
        assert!(matches!(result, Err(AuthorityError::InvalidDiscovery)));
        assert_eq!(bytes_read.get(), MAX_DISCOVERY_BYTES as usize + 1);
    }

    #[test]
    fn publisher_recognizes_exact_legacy_and_current_only() {
        let legacy = br#"{"version":1,"authorityId":"a","bootId":"b","server":{"pid":4,"creationFiletime":"5"},"pipeName":"\\\\.\\pipe\\x"}"#;
        assert!(matches!(
            recognize_predecessor(legacy),
            Ok(Predecessor::Legacy)
        ));
        assert!(matches!(
            classify_bytes(legacy),
            Err(AuthorityError::InvalidDiscovery)
        ));
        let current = br#"{"version":2,"authorityId":"a","bootId":"b","server":{"pid":4,"creationFiletime":"5"},"ownerPipeName":"\\\\.\\pipe\\x","peerPipeName":"\\\\.\\pipe\\y"}"#;
        assert!(matches!(
            recognize_predecessor(current),
            Ok(Predecessor::Current)
        ));
        assert!(classify_bytes(current).is_ok());
        let future = br#"{"version":3,"anything":true}"#;
        assert!(matches!(
            recognize_predecessor(future),
            Err(AuthorityError::FutureDiscovery)
        ));
        assert!(matches!(
            classify_bytes(future),
            Err(AuthorityError::FutureDiscovery)
        ));
        let zero = br#"{"version":0}"#;
        assert!(matches!(
            recognize_predecessor(zero),
            Err(AuthorityError::InvalidDiscovery)
        ));
        let legacy_extra = br#"{"version":1,"authorityId":"a","bootId":"b","server":{"pid":4,"creationFiletime":"5"},"pipeName":"\\\\.\\pipe\\x","extra":1}"#;
        assert!(matches!(
            recognize_predecessor(legacy_extra),
            Err(AuthorityError::InvalidDiscovery)
        ));
    }
}
