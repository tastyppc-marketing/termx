use crate::{
    security::{create_private_discovery, open_private_discovery},
    AuthorityClaim, AuthorityError, ClientBootstrap, DiscoveryRecord, WIRE_VERSION,
};
use rand::RngCore;
use std::{
    ffi::OsStr,
    fs,
    io::{Read, Write},
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
    ptr,
};
use windows_sys::Win32::Storage::FileSystem::{
    MoveFileExW, ReplaceFileW, MOVEFILE_WRITE_THROUGH, REPLACEFILE_WRITE_THROUGH,
};

const MAX_DISCOVERY_BYTES: u64 = 64 * 1024;

fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}

fn classify(record: DiscoveryRecord) -> Result<DiscoveryRecord, AuthorityError> {
    if record.version > WIRE_VERSION {
        return Err(AuthorityError::FutureDiscovery);
    }
    if !record.validate() {
        return Err(AuthorityError::InvalidDiscovery);
    }
    Ok(record)
}

fn read(path: &Path) -> Result<DiscoveryRecord, AuthorityError> {
    let file = open_private_discovery(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > MAX_DISCOVERY_BYTES {
        return Err(AuthorityError::InvalidDiscovery);
    }
    let bytes = read_bounded(file, metadata.len())?;
    classify(serde_json::from_slice(&bytes).map_err(|_| AuthorityError::InvalidDiscovery)?)
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

fn publish(root: &Path, record: &DiscoveryRecord) -> Result<(), AuthorityError> {
    classify(record.clone())?;
    let bytes = serde_json::to_vec(record).map_err(|_| AuthorityError::InvalidDiscovery)?;
    if bytes.len() as u64 > MAX_DISCOVERY_BYTES {
        return Err(AuthorityError::InvalidDiscovery);
    }

    let current = root.join("discovery.json");
    let replacing = match read(&current) {
        Ok(_) => true,
        Err(AuthorityError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(error),
    };

    let pending = unique_sibling(root, "discovery.pending");
    let mut output = create_private_discovery(&pending)?;
    output.write_all(&bytes)?;
    output.sync_all()?;
    drop(output);

    if replacing {
        let retired = root.join("retired");
        fs::create_dir_all(&retired)?;
        let backup = unique_sibling(&retired, "discovery.json");
        let ok = unsafe {
            ReplaceFileW(
                wide(current.as_os_str()).as_ptr(),
                wide(pending.as_os_str()).as_ptr(),
                wide(backup.as_os_str()).as_ptr(),
                REPLACEFILE_WRITE_THROUGH,
                ptr::null(),
                ptr::null(),
            )
        };
        if ok == 0 {
            return Err(AuthorityError::Native);
        }
    } else {
        let ok = unsafe {
            MoveFileExW(
                wide(pending.as_os_str()).as_ptr(),
                wide(current.as_os_str()).as_ptr(),
                MOVEFILE_WRITE_THROUGH,
            )
        };
        if ok == 0 {
            return Err(AuthorityError::Native);
        }
    }
    Ok(())
}

impl AuthorityClaim {
    pub fn read_discovery(&self) -> Result<DiscoveryRecord, AuthorityError> {
        read(&self.root().join("discovery.json"))
    }

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
}
