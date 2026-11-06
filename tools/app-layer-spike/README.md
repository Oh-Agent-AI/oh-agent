# C2 native macOS sandbox feasibility probe

This is a synthetic-only Cocoa probe, not City, a production broker, or an installer.
It is compiled, signed locally (no timestamp/notarization upload), and launched with
LaunchServices/open or NSWorkspace. Never run the application binary or the
menubar binary directly. Harness-side launch/identity helpers are standalone test tools.

Use Python 3.9+, macOS, and Xcode command-line tools:

~~~sh
python3 tools/app-layer-spike/run.py
python3 tools/app-layer-spike/run.py --socket-exception
python3 tools/app-layer-spike/run.py --socket-exception --network-client
python3 tools/app-layer-spike/run.py --signing-identity SIGNER --app-group TEAMID.com.mixlabpro.agent-vitals-spike
python3 tools/app-layer-spike/run.py --verify-peer --signing-identity SIGNER --app-group TEAMID.com.mixlabpro.agent-vitals-spike
~~~

SIGNER is a local signing identity selected from security find-identity. No private
key or production credential is copied into the probe. network-client is an unsafe
diagnostic control only; it must never become the City production configuration.
The TCP test talks only to a loopback listener and sends no user data. The forbidden
file is generated synthetic content, never authority or a harness log. This is not a
canary task definition or an L1 suite.

The App Group variant first resolves its dedicated group container through the
signed app, then creates a short-lived 0700 directory and 0600 socket inside it.
It must use the dedicated spike group, not a preexisting data-containing group.
No arbitrary group argument is accepted. The parent is not sandboxed, like the
current harness. Plain mode observes UID/PID only. verify-peer mode also checks:

- NSWorkspace returns an exact new bundle instance, PID and kernel process birth.
- The socket's LOCAL_PEERTOKEN is read on the actual accepted descriptor; no client
  id/PID bytes are trusted and no audit token is written to disk.
- Security.framework verifies the running guest via kSecGuestAttributeAudit,
  Developer ID/team/bundle requirement, frozen prelaunch CDHash and exact entitlements.
- PID and kernel birth are bound to this launch; birth is checked before/after validation.
- Wrong PID, birth, signed revision, sealed resources, same-UID impostor and
  matching-PID/birth wrong code are rejected.

The expected CDHash is fixed in memory after signing the synthetic bundle, before
launch. A future installer must instead bind it to the C1 verified immutable release.
Production authority must not be derived solely by rediscovering a mutable path.
The positive fixture's only payload is a synthetic report, not a production grant.

The harness asserts filesystem and socket observations, then removes its fixture
bundles, sockets and directories. macOS can retain empty app/group containers and
LaunchServices registrations. It does not edit those registries or remove broad
user directories. Timeouts terminate only the exact generated fixture executable.
Signing kinds use distinct bundle identifiers to avoid changing a sandbox
container from ad-hoc to Developer ID ownership.

Scope still missing: production verified-release/root/ledger binding,
NSSavePanel user-selected exports,
Tauri/WebView subprocess entitlements/CSP, notarization, and production group/profile
configuration. Never issue a real data grant based on this probe.

References: [Apple App Groups](https://developer.apple.com/documentation/BundleResources/Entitlements/com.apple.security.application-groups),
[group authorization](https://developer.apple.com/documentation/xcode/accessing-app-group-containers),
[sandbox temporary exceptions](https://developer.apple.com/library/archive/documentation/Miscellaneous/Reference/EntitlementKeyReference/Chapters/AppSandboxTemporaryExceptionEntitlements.html).
