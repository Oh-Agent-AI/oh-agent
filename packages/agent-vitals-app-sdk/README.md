# `@agent-vitals/app-sdk`

The app SDK provides convenience helpers for official App Game WebViews. It does
not create a new host channel: lifecycle notifications use the existing
`/ui-host` bridge, and local state goes through the descriptor-authorized
`plugin_request` methods `plugin.state.read` and `plugin.state.write`.

The package allowlist includes only `src/` and this README, so `npm pack` can
produce a bounded local tarball for an independent consumer check. The package
is still marked private and is not published; official plugin registration,
grants, signing, and installation remain desktop-host responsibilities.

```ts
import { connectAppGame, createAppHostClient } from "@agent-vitals/app-sdk";

const host = createAppHostClient();
const dispose = await connectAppGame({
  async start() {
    const saved = await host.state.read("race-profile:v1");
    // Initialize the game using saved.value and saved.revision.
  },
  suspend() { /* pause simulation */ },
  resume() { /* resume simulation */ },
  dispose() { /* release app-owned resources */ },
});

// Call dispose() when the app is explicitly torn down. It is also invoked on pagehide.
```

`connectAppGame` waits for `start()` and an acknowledged empty `toolbar.update`
before resolving. A startup or lifecycle failure sends `runtime.error`; startup
failure also invokes `dispose()` to release partially initialized resources.
Repeated suspend/resume notifications are coalesced, and `dispose()` is
idempotent.

State keys must be declared by the registered plugin descriptor (for example,
`race-profile:v1`). Read results contain `{ value, revision }`; writes use that
revision and return the incremented revision. The host remains authoritative
for descriptor grants, concurrency, persistence and its 48 KiB serialized
document limit. The SDK checks key/value shape and size locally, validates the
versioned response envelope, and propagates stable host error codes. It does not
expose filesystem access or a generic IPC method.
