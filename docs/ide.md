# Antigravity IDE adapter (experimental)

The VS Code-based **Antigravity IDE** and the standalone Electron desktop agent
have different runtimes. Use these commands for the IDE; use `deploy.mjs` for the
standalone app. The IDE adapter changes the declared `jetski.cloudCodeUrl` user
setting and starts an independent local proxy. It does not replace vendor code.

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

Preflight requires recognized Antigravity product metadata, an unpacked
`app/out/main.js` entry point and an extension that actually declares
`jetski.cloudCodeUrl`. Unsupported layouts fail before settings are changed.
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
Never copy another application's OAuth client secrets or extracted tokens.

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
No live Antigravity IDE installation or signed-in Google account was available
for this implementation's verification.

This is **experimental integration**, not a claim that every IDE release's
native model picker works. The proxy supports Cloud Code model discovery and
generation; IDE releases obtaining their picker through the language server's
`GetUserStatus` RPC may require another version-specific hook. That hook is not
installed here. If models are absent, provide the IDE version, OS, preflight
output and the request path (without credentials). Do not apply the standalone
binary patch to the IDE as a workaround.
