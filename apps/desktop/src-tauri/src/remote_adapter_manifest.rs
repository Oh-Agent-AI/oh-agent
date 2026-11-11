//! Explicit inventory of trusted, built-in remote adapters.
//!
//! Keeping this list separate from the generic registry makes the trust decision
//! visible while preventing the registry and host dispatch path from depending on
//! an individual game's module.

use crate::remote_protocol::RemoteCapability;
use crate::remote_registry::{self, AdapterRegistration};

type RegistrationSource = fn() -> &'static [AdapterRegistration];

// Production remote sessions are authorized by the packaged capability and
// session profile, then handled by the trusted TypeScript app adapter. Keep
// historical Rust adapters available to parity tests without making every
// new game require a Rust registry entry.
#[cfg(test)]
static SOURCES: &[RegistrationSource] = &[crate::mecha_remote_adapter::control_registrations];
#[cfg(not(test))]
static SOURCES: &[RegistrationSource] = &[];

pub(crate) fn registered(app_id: &str, capabilities: &[RemoteCapability], method: &str) -> Option<&'static AdapterRegistration> {
    SOURCES.iter().find_map(|source| remote_registry::lookup(source(), app_id, capabilities, method))
}

pub(crate) fn for_capability(app_id: &str, capability: &RemoteCapability) -> Option<&'static AdapterRegistration> {
    SOURCES.iter().find_map(|source| source().iter().find(|entry| {
        entry.app_id == app_id && entry.capability_id == capability.id && (entry.supports)(capability)
    }))
}

pub(crate) fn for_identity(app_id: &str, capability_id: &str) -> Option<&'static AdapterRegistration> {
    SOURCES.iter().find_map(|source| source().iter().find(|entry| {
        entry.app_id == app_id && entry.capability_id == capability_id
    }))
}
