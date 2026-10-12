# Antigravity IDE setup

The VS Code-based **Antigravity IDE** and the standalone Electron desktop agent
have different runtimes. Use these commands for the IDE; use `deploy.mjs` for the
standalone app. The IDE adapter changes the verified `jetski.cloudCodeUrl` user
setting and starts an independent local proxy. It does not replace vendor code.

The current verified release is **Antigravity IDE 2.5.5**, based on **VS Code
1.107.0**. `ide:check` reports these separately as `ideVersion` and `version`.
Install the IDE edition from the [official download page](https://antigravity.google/download).

## Check, configure and launch

Build this repository with Node.js 22.13 or newer:

```sh
npm ci --ignore-scripts
npm run build
npm run ide:check -- --resources "/path/to/Antigravity IDE/resources"
npm run ide:apply -- --resources "/path/to/Antigravity IDE/resources"
npm run proxy:start -- --open
npm run ide:launch -- --resources "/path/to/Antigravity IDE/resources"
```

`--resources` also accepts an installation root or a macOS `.app`. Close the IDE
before applying settings, then use `ide:launch` to start it. Launch waits for the
owned proxy to become healthy before opening the verified IDE executable. It
passes the configured user-data directory so the correct settings are loaded.
It does not install an OS startup task: opening the ordinary IDE shortcut still
requires the proxy to be running.

Preflight requires recognized Antigravity product metadata and an unpacked
`app/out/main.js` entry point. It accepts an extension that declares
`jetski.cloudCodeUrl`, or the inspected IDE 2.5.5 core implementation. That release
uses the setting internally without declaring it in the extension manifest;
preflight verifies its release commit, product/extension identity and both core
and language-server endpoint code. Unsupported layouts fail before settings change.
An IDE packaged only in `app.asar` is not supported by this adapter.

The default loopback port is **50999**. To change it, supply `--port 51001` to
`ide:apply` and `proxy:start`; launch reads the configured port. Restore before
changing an already managed endpoint. A busy port is an error, never a silent
fallback to a different port.

Optional arguments:

| Argument | Purpose |
| --- | --- |
| `--settings "/path/User/settings.json"` | Explicit settings file, including a portable user-data directory. |
| `--data-dir "/path/model-data"` | Model/credential/service state directory for `proxy:start` and `ide:launch`. Use the same directory for both and for proxy status/stop. |
| `--executable "/path/Antigravity.exe"` | Choose an executable next to the recognized resources; arbitrary executables are refused. |

`apply`/`restore` support explicit named-profile settings, but `ide:launch` only
supports `USER_DATA_DIR/User/settings.json`. For a named profile, start the proxy
and select that profile in the IDE yourself.

Complete the IDE's own Google sign-in and onboarding. The adapter preserves this
login flow. Its proxy starts account setup on the production Cloud Code endpoint
and follows the returned tier's endpoint choice; routing state is isolated per
bearer digest and expires after one hour. A browser authentication-success page
can appear before IDE account setup finishes, so confirm sign-in in the IDE too.

## Model manager and credentials

`proxy:start -- --open` opens the browser manager. It has the same model editor,
provider discovery, import/export, Google account controls and gateway connection
as the desktop addon. **Diagnostics** shows measured recent requests;
**Test generation** explicitly sends a small request that can consume provider
quota. The ordinary **Test connection** continues to check connectivity/catalogs.

The manager URL includes an access token in its fragment. The page moves this
token into tab session storage; it is not sent as a URL query or logged in HTTP
paths. Management actions require the token and the exact loopback origin.
Keep that URL private. Generation remains available to local IDE processes;
the service rejects cross-origin browser requests and unrecognized Host headers.
Use the separate authenticated [gateway](../gateway/README.md) for remote access.

By default models use `~/.gemini/antigravity/custom_models.json`. Node service
credentials use AES-256-GCM with a local user key in that directory. Credentials
encrypted by Electron's OS `safeStorage` cannot be decrypted by plain Node:
re-enter them in the manager, or use a separate `--data-dir` for the IDE.
The manager's optional Google account pool is separate from the IDE's own login.
It uses the [explicit account setup](configuration.md#google-cloud-code-account-pools)
described in the configuration guide.

## Native model identities and capacity

IDE 2.5.5 builds its native picker from the Cloud Code model catalog and its
sort/group entries. The proxy adds configured models to both and allocates a
distinct native enum identity for each saved model, including effort variants.
The browser manager and desktop preload receive those same authoritative IDs.

The inspected IDE schema has **651 placeholder values**. Native-model
reservations and retained assignments for deleted models consume part of that
pool, so this is an upper bound rather than a promise of 651 extra entries.
Models beyond the available native slots remain editable and accessible through
their direct API aliases; the manager explains why native picker injection is
unavailable. Provider discovery and saved configuration are not limited to this
native picker capacity.

Assignments live in `<data-dir>/custom_model_identities.json`. They survive
display-name changes, model reordering and service restarts. Deleted-model
assignments remain reserved so a cached IDE selection cannot silently select a
different provider. Back up this file with `custom_models.json` and the local
credential key. Restoring only the model list can lose these stable identities.

## Status and recovery

```sh
npm run ide:status -- --resources "/path/to/Antigravity IDE/resources"
npm run proxy:status
npm run proxy:stop
npm run ide:restore -- --resources "/path/to/Antigravity IDE/resources"
```

Settings backups and a hash-checked manifest live beside the settings file in
`settings.json.antigravity-model-patch`. Restore returns exact original bytes
when unchanged, or restores only the managed property while preserving unrelated
later edits. It refuses a conflicting manual endpoint change or damaged backup.
Keep these backups until the adapter is removed. Comments and trailing commas
are supported; duplicate keys and malformed JSONC are rejected.

Service state/logs live under `<data-dir>/.ide-proxy/`. Start is idempotent for
the same directory and port. Stop authenticates the owned instance; it does not
kill a process just because it uses that port or an old recorded PID.

## Validation boundary

Installer fixtures cover Windows/macOS/Linux layouts, settings preservation,
restore conflicts and startup ordering. HTTP fixtures test the real Node proxy,
encrypted model persistence, browser management, local generation and lifecycle.

| Check | Result |
| --- | --- |
| Official IDE 2.5.5 Windows and Linux artifacts | Download hashes verified; Windows Google LLC signature verified; actual runtime and protobuf schema inspected. |
| Adapter against authentic resources | Preflight accepts both extracted builds through the verified hidden core setting. |
| Live Windows IDE login | Confirmed signed in after correcting buffered HTTP forwarding and initial Cloud Code host selection. |
| Extracted vendor catalog/picker functions with 320 configured models | Produced 320 distinct native selections, including duplicate display labels; enum symbols checked against the official descriptor. IDs survived reorder/rename and preserved native reservations. |
| Live Windows IDE 2.5.5 native picker | Displayed the configured test model and its low/medium/high effort variants; the base model was selected from the real picker. |
| Live Windows IDE 2.5.5 streamed chat | An actual IDE `streamGenerateContent` request reached a local OpenAI-compatible `/v1/chat/completions` endpoint, returned HTTP 200 SSE, and rendered `IDE LIVE ROUTE OK` in the native chat. |
| Live effort variant routing | Selecting the medium variant in the native picker sent `reasoning_effort: "medium"` to the same upstream model and rendered a second successful streamed response. |
| Live adapter recovery and launch | Restored and reapplied the isolated profile setting; managed launch started the real Windows executable and its owned proxy. The interactive IDE window is shown rather than hidden by the background-service launch flag. |

The extracted-function check uses captured message constructors. It verifies the
vendor selection logic and enum values; it does not substitute for a complete
protobuf decode or live IDE interaction.

The live check ran on **2026-10-12**, using an isolated Windows profile and a
local OpenAI-compatible test provider. Linux source inspection and macOS
installer fixtures are separate checks; their desktop UI flows and paid-provider
generation were not part of this live run.

This release obtains its picker through `fetchAvailableModels` and native
unified-state updates; it does not require a `GetUserStatus` RPC injection.
Other IDE releases need their own compatibility evidence. If models are absent,
include the IDE version, OS, `ide:check` output and request path without
credentials. The standalone desktop binary patch is a different installer.
