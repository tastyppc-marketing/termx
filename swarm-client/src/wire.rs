use serde::{de, Deserialize, Deserializer, Serialize, Serializer};
use std::{fmt, str::FromStr};

pub const WIRE_VERSION: u16 = 1;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct DecimalU64(u64);

impl DecimalU64 {
    pub const fn new(value: u64) -> Self {
        Self(value)
    }
    pub fn parse(value: &str) -> Result<Self, &'static str> {
        if value.is_empty()
            || (value.len() > 1 && value.starts_with('0'))
            || !value.bytes().all(|b| b.is_ascii_digit())
        {
            return Err("noncanonical decimal");
        }
        u64::from_str(value)
            .map(Self)
            .map_err(|_| "decimal overflow")
    }
    pub const fn get(self) -> u64 {
        self.0
    }
}
impl fmt::Display for DecimalU64 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}
impl fmt::Debug for DecimalU64 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("DecimalU64")
            .field(&self.to_string())
            .finish()
    }
}
impl Serialize for DecimalU64 {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}
impl<'de> Deserialize<'de> for DecimalU64 {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let text = String::deserialize(d)?;
        Self::parse(&text).map_err(de::Error::custom)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Hello {
    pub boot_id: String,
}
impl Hello {
    pub fn new(boot_id: impl Into<String>) -> Self {
        Self {
            boot_id: boot_id.into(),
        }
    }
    pub fn boot_id(&self) -> &str {
        &self.boot_id
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "payload", rename_all = "snake_case")]
enum RequestKind {
    Hello(Hello),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RequestEnvelope {
    version: u16,
    correlation_id: String,
    #[serde(flatten)]
    kind: RequestKind,
}
impl RequestEnvelope {
    pub fn hello(correlation_id: impl Into<String>, hello: Hello) -> Self {
        Self {
            version: WIRE_VERSION,
            correlation_id: correlation_id.into(),
            kind: RequestKind::Hello(hello),
        }
    }
    pub fn correlation_id(&self) -> &str {
        &self.correlation_id
    }
    pub fn hello_payload(&self) -> &Hello {
        match &self.kind {
            RequestKind::Hello(hello) => hello,
        }
    }
    pub(crate) fn valid(&self) -> bool {
        self.version == WIRE_VERSION
            && valid_id(&self.correlation_id)
            && match &self.kind {
                RequestKind::Hello(v) => valid_id(&v.boot_id),
            }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ResponseEnvelope {
    version: u16,
    correlation_id: String,
    accepted: bool,
}
impl ResponseEnvelope {
    pub fn new(correlation_id: impl Into<String>, accepted: bool) -> Self {
        Self {
            version: WIRE_VERSION,
            correlation_id: correlation_id.into(),
            accepted,
        }
    }
    pub fn correlation_id(&self) -> &str {
        &self.correlation_id
    }
    pub const fn accepted(&self) -> bool {
        self.accepted
    }
    pub(crate) fn valid(&self) -> bool {
        self.version == WIRE_VERSION && valid_id(&self.correlation_id)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DiscoveryRecord {
    pub version: u16,
    pub authority_id: String,
    pub boot_id: String,
    pub server: super::ProcessIdentity,
    pub pipe_name: String,
}
impl DiscoveryRecord {
    pub fn new(
        authority_id: impl Into<String>,
        boot_id: impl Into<String>,
        server: super::ProcessIdentity,
        pipe_name: impl Into<String>,
    ) -> Self {
        Self {
            version: WIRE_VERSION,
            authority_id: authority_id.into(),
            boot_id: boot_id.into(),
            server,
            pipe_name: pipe_name.into(),
        }
    }
    pub fn validate(&self) -> bool {
        self.version == WIRE_VERSION
            && valid_id(&self.authority_id)
            && valid_id(&self.boot_id)
            && self.server.pid != 0
            && self.server.creation_filetime.get() != 0
            && self
                .pipe_name
                .strip_prefix(r"\\.\pipe\")
                .is_some_and(valid_id)
    }
}
pub(crate) fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}
