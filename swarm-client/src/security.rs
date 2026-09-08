use rand::RngCore;
use std::{
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
};

#[derive(Debug, thiserror::Error)]
pub enum AuthorityError {
    #[error("authority is already owned")]
    Busy,
    #[error("insecure credential object")]
    InsecureCredential,
    #[error("unsupported object type")]
    ObjectType,
    #[error("discovery document is invalid")]
    InvalidDiscovery,
    #[error("discovery document uses an unsupported future version")]
    FutureDiscovery,
    #[error("native authority unavailable")]
    Native,
    #[error("authority I/O unavailable")]
    Io(#[from] std::io::Error),
}

pub struct OwnerCredential([u8; 32]);
impl OwnerCredential {
    pub fn matches(&self, other: &Self) -> bool {
        let mut d = 0u8;
        for i in 0..32 {
            d |= self.0[i] ^ other.0[i]
        }
        d == 0
    }
    pub(crate) fn bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub(crate) fn matches_bytes(&self, other: &[u8]) -> bool {
        if other.len() != self.0.len() {
            return false;
        }
        self.0
            .iter()
            .zip(other)
            .fold(0u8, |difference, (left, right)| difference | (left ^ right))
            == 0
    }
}

pub struct AuthorityClaim {
    _directory: File,
    _lock: File,
    root: PathBuf,
}

pub struct ClientBootstrap {
    _directory: File,
    root: PathBuf,
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::{
        ffi::OsStr,
        os::windows::{
            ffi::OsStrExt,
            fs::OpenOptionsExt,
            io::{AsRawHandle, FromRawHandle},
        },
        ptr,
    };
    use windows_sys::Win32::{
        Foundation::{
            CloseHandle, GetHandleInformation, LocalFree, GENERIC_READ, GENERIC_WRITE, HANDLE,
            HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE,
        },
        Security::{
            Authorization::{
                ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
                GetSecurityInfo, SE_FILE_OBJECT,
            },
            EqualSid, GetAce, GetSecurityDescriptorControl, GetTokenInformation, TokenUser,
            ACCESS_ALLOWED_ACE, ACL, DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION,
            PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, SE_DACL_PROTECTED, TOKEN_QUERY, TOKEN_USER,
        },
        Storage::FileSystem::{
            CreateFileW, GetFileInformationByHandle, GetFileType, GetFinalPathNameByHandleW,
            BY_HANDLE_FILE_INFORMATION, CREATE_NEW, FILE_ATTRIBUTE_DIRECTORY,
            FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
            FILE_NAME_NORMALIZED, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TYPE_DISK, OPEN_EXISTING,
            READ_CONTROL, VOLUME_NAME_DOS,
        },
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    };
    fn wide(p: &OsStr) -> Vec<u16> {
        p.encode_wide().chain(Some(0)).collect()
    }
    fn verify_noninheritable(file: &File) -> Result<(), AuthorityError> {
        let mut flags = 0;
        if unsafe { GetHandleInformation(file.as_raw_handle() as HANDLE, &mut flags) } == 0
            || flags & HANDLE_FLAG_INHERIT != 0
        {
            return Err(AuthorityError::Native);
        }
        Ok(())
    }
    fn open_directory(path: &Path) -> Result<File, AuthorityError> {
        unsafe {
            let h = CreateFileW(
                wide(path.as_os_str()).as_ptr(),
                GENERIC_READ,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                ptr::null_mut(),
            );
            if h == INVALID_HANDLE_VALUE {
                return Err(AuthorityError::Native);
            };
            let mut info = std::mem::zeroed::<BY_HANDLE_FILE_INFORMATION>();
            if GetFileInformationByHandle(h, &mut info) == 0
                || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
                || info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
            {
                CloseHandle(h);
                return Err(AuthorityError::ObjectType);
            }
            let file = File::from_raw_handle(h as _);
            verify_noninheritable(&file)?;
            Ok(file)
        }
    }

    fn final_path(directory: &File) -> Result<PathBuf, AuthorityError> {
        let handle = directory.as_raw_handle() as HANDLE;
        let mut buffer = vec![0u16; 512];
        loop {
            let length = unsafe {
                GetFinalPathNameByHandleW(
                    handle,
                    buffer.as_mut_ptr(),
                    buffer.len() as u32,
                    FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
                )
            } as usize;
            if length == 0 {
                return Err(AuthorityError::Native);
            }
            if length < buffer.len() {
                return Ok(PathBuf::from(String::from_utf16_lossy(&buffer[..length])));
            }
            buffer.resize(length + 1, 0);
        }
    }

    pub(super) fn claim(path: &Path) -> Result<AuthorityClaim, AuthorityError> {
        std::fs::create_dir_all(path)?;
        let directory = open_directory(path)?;
        let root = final_path(&directory)?;
        let mut o = std::fs::OpenOptions::new();
        o.read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .share_mode(0);
        let lock = o.open(root.join("authority.lock")).map_err(|e| {
            if e.raw_os_error() == Some(32) {
                AuthorityError::Busy
            } else {
                AuthorityError::Io(e)
            }
        })?;
        verify_noninheritable(&lock)?;
        Ok(AuthorityClaim {
            _directory: directory,
            _lock: lock,
            root,
        })
    }
    pub(super) fn client(path: &Path) -> Result<ClientBootstrap, AuthorityError> {
        let directory = open_directory(path)?;
        let root = final_path(&directory)?;
        Ok(ClientBootstrap {
            _directory: directory,
            root,
        })
    }
    fn current_sid_string() -> Result<String, AuthorityError> {
        unsafe {
            let mut token = ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return Err(AuthorityError::Native);
            };
            let mut needed = 0;
            GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut needed);
            let mut buf = vec![0u8; needed as usize];
            if GetTokenInformation(
                token,
                TokenUser,
                buf.as_mut_ptr().cast(),
                needed,
                &mut needed,
            ) == 0
            {
                CloseHandle(token);
                return Err(AuthorityError::Native);
            };
            let sid = (*(buf.as_ptr() as *const TOKEN_USER)).User.Sid;
            let mut text = ptr::null_mut();
            if ConvertSidToStringSidW(sid, &mut text) == 0 {
                CloseHandle(token);
                return Err(AuthorityError::Native);
            };
            let mut n = 0;
            while *text.add(n) != 0 {
                n += 1
            }
            let value = String::from_utf16_lossy(std::slice::from_raw_parts(text, n));
            let _ = LocalFree(text.cast());
            CloseHandle(token);
            Ok(value)
        }
    }
    fn credential_object_info(file: &File) -> Result<BY_HANDLE_FILE_INFORMATION, AuthorityError> {
        unsafe {
            let mut info = std::mem::zeroed::<BY_HANDLE_FILE_INFORMATION>();
            if GetFileInformationByHandle(file.as_raw_handle() as HANDLE, &mut info) == 0 {
                return Err(AuthorityError::Native);
            }
            if info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)
                != 0
                || GetFileType(file.as_raw_handle() as HANDLE) != FILE_TYPE_DISK
            {
                return Err(AuthorityError::ObjectType);
            }
            Ok(info)
        }
    }

    fn open_existing_credential(path: &Path) -> Result<File, AuthorityError> {
        unsafe {
            let inspection = CreateFileW(
                wide(path.as_os_str()).as_ptr(),
                0,
                FILE_SHARE_READ,
                ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                ptr::null_mut(),
            );
            if inspection == INVALID_HANDLE_VALUE {
                return Err(AuthorityError::Native);
            }
            let inspection = File::from_raw_handle(inspection as _);
            verify_noninheritable(&inspection)?;
            let expected = credential_object_info(&inspection)?;
            let content = CreateFileW(
                wide(path.as_os_str()).as_ptr(),
                GENERIC_READ | READ_CONTROL,
                FILE_SHARE_READ,
                ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_OPEN_REPARSE_POINT,
                ptr::null_mut(),
            );
            if content == INVALID_HANDLE_VALUE {
                return Err(AuthorityError::Native);
            }
            let file = File::from_raw_handle(content as _);
            verify_noninheritable(&file)?;
            let actual = credential_object_info(&file)?;
            if actual.dwVolumeSerialNumber != expected.dwVolumeSerialNumber
                || actual.nFileIndexHigh != expected.nFileIndexHigh
                || actual.nFileIndexLow != expected.nFileIndexLow
            {
                return Err(AuthorityError::ObjectType);
            }
            Ok(file)
        }
    }

    fn secure_open(path: &Path) -> Result<(File, bool), AuthorityError> {
        unsafe {
            let mut sd: PSECURITY_DESCRIPTOR = ptr::null_mut();
            let sid = current_sid_string()?;
            let s: Vec<u16> = format!("O:{sid}D:P(A;;GRGW;;;{sid})\0")
                .encode_utf16()
                .collect();
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(
                s.as_ptr(),
                1,
                &mut sd,
                ptr::null_mut(),
            ) == 0
            {
                return Err(AuthorityError::Native);
            };
            let sa = SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: sd,
                bInheritHandle: 0,
            };
            let h = CreateFileW(
                wide(path.as_os_str()).as_ptr(),
                GENERIC_READ | GENERIC_WRITE | READ_CONTROL,
                FILE_SHARE_READ,
                &sa,
                CREATE_NEW,
                FILE_ATTRIBUTE_NORMAL,
                ptr::null_mut(),
            );
            let _ = LocalFree(sd);
            if h == INVALID_HANDLE_VALUE {
                return open_existing_credential(path).map(|file| (file, true));
            }
            let file = File::from_raw_handle(h as _);
            verify_noninheritable(&file)?;
            credential_object_info(&file)?;
            Ok((file, false))
        }
    }
    fn validate_acl(file: &File) -> Result<(), AuthorityError> {
        let current_sid = current_sid_string()?;
        unsafe {
            let mut owner = ptr::null_mut();
            let mut dacl: *mut ACL = ptr::null_mut();
            let mut sd = ptr::null_mut();
            let rc = GetSecurityInfo(
                file.as_raw_handle() as HANDLE,
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner,
                ptr::null_mut(),
                &mut dacl,
                ptr::null_mut(),
                &mut sd,
            );
            if rc != 0 || owner.is_null() || dacl.is_null() {
                if !sd.is_null() {
                    let _ = LocalFree(sd);
                }
                return Err(AuthorityError::InsecureCredential);
            }
            let mut control = 0;
            let mut revision = 0;
            let mut ace = ptr::null_mut();
            let mut ok = sid_string(owner).ok().as_ref() == Some(&current_sid)
                && GetSecurityDescriptorControl(sd, &mut control, &mut revision) != 0
                && control & SE_DACL_PROTECTED != 0
                && (*dacl).AceCount == 1
                && GetAce(dacl, 0, &mut ace) != 0;
            if ok {
                let allowed = ace as *mut ACCESS_ALLOWED_ACE;
                let sid = ptr::addr_of_mut!((*allowed).SidStart).cast();
                let mask = (*allowed).Mask;
                ok = (*allowed).Header.AceType == 0
                    && (mask == (GENERIC_READ | GENERIC_WRITE)
                        || mask == (FILE_GENERIC_READ | FILE_GENERIC_WRITE))
                    && EqualSid(owner, sid) != 0;
            }
            let _ = LocalFree(sd);
            if ok {
                Ok(())
            } else {
                Err(AuthorityError::InsecureCredential)
            }
        }
    }

    unsafe fn sid_string(sid: *mut core::ffi::c_void) -> Result<String, AuthorityError> {
        let mut text = ptr::null_mut();
        if ConvertSidToStringSidW(sid, &mut text) == 0 {
            return Err(AuthorityError::Native);
        }
        let mut n = 0;
        while *text.add(n) != 0 {
            n += 1;
        }
        let value = String::from_utf16_lossy(std::slice::from_raw_parts(text, n));
        let _ = LocalFree(text.cast());
        Ok(value)
    }
    fn read_credential(mut file: File) -> Result<OwnerCredential, AuthorityError> {
        validate_acl(&file)?;
        let mut bytes = [0; 32];
        file.read_exact(&mut bytes)
            .map_err(|_| AuthorityError::InsecureCredential)?;
        let mut extra = [0];
        if file.read(&mut extra)? != 0 {
            return Err(AuthorityError::InsecureCredential);
        }
        Ok(OwnerCredential(bytes))
    }

    pub(super) fn load_credential(path: &Path) -> Result<OwnerCredential, AuthorityError> {
        read_credential(open_existing_credential(path)?)
    }

    pub(super) fn credential(path: &Path) -> Result<OwnerCredential, AuthorityError> {
        let (mut file, existed) = secure_open(path)?;
        validate_acl(&file)?;
        if existed {
            read_credential(file)
        } else {
            let mut b = [0; 32];
            rand::rngs::OsRng.fill_bytes(&mut b);
            file.write_all(&b)?;
            file.sync_all()?;
            Ok(OwnerCredential(b))
        }
    }
}

impl ClientBootstrap {
    #[cfg(windows)]
    pub fn open(path: &Path) -> Result<Self, AuthorityError> {
        windows::client(path)
    }

    pub fn load_owner_credential(&self) -> Result<OwnerCredential, AuthorityError> {
        windows::load_credential(&self.root.join("owner.credential"))
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }
}

impl AuthorityClaim {
    #[cfg(windows)]
    pub fn claim(path: &Path) -> Result<Self, AuthorityError> {
        windows::claim(path)
    }
    pub fn load_or_create_owner_credential(&self) -> Result<OwnerCredential, AuthorityError> {
        windows::credential(&self.root.join("owner.credential"))
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }
}
