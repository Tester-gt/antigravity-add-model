# Model configuration

Use **Settings → Models & Usage → Custom Models** in the standalone desktop app.
Older versions call this page **Models**. The editor and Import action validate
configuration and encrypt credentials before saving.

## Model files and import

Desktop models live at `~/.gemini/antigravity/custom_models.json`. Import accepts
a `models` object, a model array, or provider groups with inherited defaults, as
JSON or base64-encoded JSON. Existing internal names are updated; new names are
added. Provider-group defaults become independent model entries after import.

This secret-free example targets a local OpenAI-compatible server. Replace
`YOUR_LOCAL_MODEL_ID` with an ID returned by **Discover local** or your server:

```json
{
  "models": [
    {
      "name": "models/local-example",
      "displayName": "Local example",
      "provider": "lmstudio",
      "apiFormat": "openai",
      "apiUrl": "http://127.0.0.1:1234/v1",
      "apiKey": "",
      "externalModelName": "YOUR_LOCAL_MODEL_ID",
      "enabled": true,
      "contextWindow": 32768,
      "maxOutputTokens": 4096,
      "timeout": 120000,
      "maxRetries": 2
    }
  ]
}
```

Choose limits supported by your actual model. The example does not install a
server or download a model. A local server that requires authentication still
needs its own API key.

## Discover and select models

Select a provider, enter its key and endpoint, then choose **Fetch provider models**.
Search the returned catalog by model name or ID. **Select filtered** selects the
current matches; selections remain checked when you change the search. **Add
selected** saves all checked models, including selections outside the current filter.

When available, discovery imports each model's context/output limits and image
and reasoning metadata. Explicit values in **Advanced settings** take priority.
An output limit at least as large as the context is reduced to leave input room.
Missing metadata keeps the normal defaults; review limits and capabilities for
your chosen model. Discovery does not generate a completion or verify tool use.
See [providers and model catalogs](providers.md) for endpoints and service-specific details.

## Image inputs

Choose a model and endpoint that actually support image understanding. Discovery
imports image capability metadata when the provider supplies it; otherwise the
addon recognizes known vision model names, including DeepSeek-VL/VL2 and
Janus/Janus-Pro. These open models require a compatible serving endpoint; their
names alone do not make them available on the hosted DeepSeek API. See the
[DeepSeek vision guide](https://api-docs.deepseek.com/guides/vision/) for currently
supported hosted models.

In the model editor, **Advanced settings → Image input → Supported** explicitly
enables image attachments. **Unsupported** disables them; **Auto detect** uses the
model's default detection. JSON/import users can set `supportsVision: true` or
`false`. Both values take priority over name detection. This setting cannot add
vision to a text-only upstream model.

The desktop proxy forwards PNG, JPEG, GIF and WebP images as native image blocks
for OpenAI-compatible and Anthropic-compatible endpoints. It preserves images in
user conversation history, including images beside tool results. Inline base64,
base64 data URLs and local `file://` images are sent as image data; HTTP(S) image
URLs are passed to the selected provider and must be publicly accessible. Private URLs requiring a
separate login must be supplied as inline image data or a local file instead.
Incoming Google credentials are not forwarded to image URLs. Unsupported image
formats and unreadable local images return a clear error instead of being sent
as text. These formats accept image input in user messages.

Desktop context trimming budgets an estimated 1024 tokens per image rather than
treating base64 bytes as text tokens. Actual image cost depends on the provider,
model and resolution; upstream image-size and context limits still apply.

## Fields and advanced settings

Most fields are exposed under **Advanced settings**. Fields marked JSON/import
are supported in configuration but do not have a separate editor control.

| Field | Meaning |
| --- | --- |
| `name` | Unique saved identifier, normally `models/<name>`; used by fallback references. |
| `displayName`, `description` | Display label and optional description. |
| `provider` | Preset ID from [providers.ts](../src/providers.ts), including `custom` and `google-cloudcode`. |
| `apiFormat` | `openai`, `anthropic`, or `google`; determines wire format independently of the preset name. Cloud Code requires `google`. |
| `apiUrl`, `externalModelName` | HTTP(S) endpoint and exact upstream model ID. Do not embed credentials in URLs. |
| `apiKey` | Provider key; empty for a local endpoint without authentication. Saved values are masked. |
| `enabled` | Defaults to enabled; disabled models stay saved but leave the custom picker and fallback chain. |
| `reasoningEffort` | Optional `none`, `minimal`, `low`, `medium`, `high`, or `xhigh`; sent for the OpenAI format when configured. Model support varies. |
| `thinkingBudget` | Nonnegative token budget for supported Google/Anthropic requests. For Anthropic, `0` disables thinking; otherwise use at least `1024` and less than the output limit. |
| `maxOutputTokens`, `contextWindow` | Positive token limits. If both exist, output must be smaller than context. Limits cannot enlarge the upstream model's capacity. |
| `timeout` | Per-attempt timeout in milliseconds; default `120000`. |
| `idleTimeout`, `retryBudgetMs` | JSON/import: idle timeout (default `30000`) and overall retry/fallback time budget. Without an override, the latter is at least `120000` or the configured timeout, whichever is larger. |
| `maxRetries` | Integer `0`–`5`, default `3`. Time budgets can stop attempts earlier. |
| `fallbackModels` | Ordered array of up to 20 saved internal names. The editor accepts a comma-separated list. |
| `circuitBreaker` | `enabled`, `failureThreshold`, `cooldownMs`; default threshold `3`, cooldown `30000` ms. |
| `customHeaders` | Object of string header values. Reserved transport headers and line breaks are rejected. |
| `extraBody` | Additional JSON request fields; cannot replace model/messages/contents/system/tools/stream routing fields. Ordinary exported configuration, not secret storage. |
| `rawUrl` | Use the exact request URL instead of protocol path normalization. |
| `supportsVision`, `supportsThinking` | Advertised capability overrides. Thinking capability is JSON/import; these flags do not add upstream capabilities. |
| `allowUnauthorized` | Disable certificate verification for this model only; leave false for normal endpoints. |
| `gateway` | JSON/import: marks an imported gateway route and forwards conversation identity for gateway sessions. Set automatically by **Import model aliases**. |
| `googleAccounts`, `googleProject`, `googlePool` | Cloud Code accounts, optional default project, and account-selection settings; see below. |

Timeout/budget fields accept `1`–`3600000` milliseconds. Context limiting uses a
rough token estimate and removes whole oldest turns while preserving
supported tool exchanges. The proxy refuses a latest turn that still cannot fit.
Retries and fallback stop after output starts; they do not duplicate an already
streamed answer. Renaming/deleting a model updates its saved fallback references.
For parallel workloads, see [fallback chains for rate-limited providers](providers.md#fallback-chains-for-rate-limited-providers)
for worked examples, retry timing and the separate MCP delegation behavior.

Old DeepSeek, Kimi, Fireworks, LM Studio, and llama.cpp entries without
`apiFormat` retain their historical Anthropic format. Select the intended format
explicitly when migrating a configuration.

## Subagent model selection

When Antigravity exposes the `invoke_subagent` tool, a conversation using either
a built-in or custom model can choose an enabled configured model through
`Subagents[].Model`. Use the model's exact saved `name`, such as
`models/local-example` from the import above;
the display label and upstream provider model ID are not interchangeable with
this name. Configure and enable the target model first, then include its saved
name when asking the agent to delegate work.

The native values `inherit`, `flash_lite`, `flash`, and `pro` remain available.
`inherit` (also the default when omitted) follows the calling agent's model,
including a custom model selected for that subagent. Explicit native tiers keep
Antigravity's own tier selection. Unknown, ambiguous, or disabled custom model
selections produce an error instead of silently choosing another model.

The proxy gives each custom-model spawn its own temporary routing marker. The
child's first request can select its model before the parent receives the tool
result, and parallel calls do not share a fallback tool-call ID. Markers are
removed before forwarding the child's prompt to a provider; replayed parent
history restores the original prompt and `Model` even after switching between
Gemini, OpenAI-compatible, and Anthropic-compatible providers.

Built-in Google/Cloud Code parents use the same routing bridge. The proxy exposes
custom model selection in their tool schema and rewrites their JSON or SSE tool
responses before Antigravity validates the native model tier. Cloud Code response
envelopes and compressed responses are handled without dropping their metadata.
An invalid selection returns an explicit error; if a stream has already started,
the proxy emits a terminal SSE error instead of forwarding an invalid tool call.

Routing state is held in proxy memory, with a one-hour inactivity limit and up
to 4,096 entries per routing cache. Start new subagents after restarting the
proxy or when a route has expired; a child using an unavailable marker reports
an error. Expired markers in parent tool history are removed so the parent can
continue and spawn fresh children; its original custom selection can only be
restored while the corresponding routing state remains available. This feature
depends on Antigravity supplying the child prompt or a stable conversation
identity, and does not add native subagent tools to clients that do not expose
them. Automated routing coverage uses local HTTP fixtures. Actual Windows IDE
2.5.5 requests from both built-in Gemini and custom parents did not declare
`invoke_subagent`. Google lists native subagents for the separate Antigravity 2.0
app and CLI in its [subagent documentation](https://antigravity.google/docs/subagents/).

For the IDE, use the supported [MCP delegation setup](ide.md#delegate-to-custom-models-with-mcp).
The `delegate_to_model` tool sends an independent text task to an exact saved
custom model and returns its answer to the parent. This worker has no IDE tools,
filesystem access or inherited conversation; it does not open a native child
window. Native `invoke_subagent` routing remains available in clients that
actually expose that tool.

## Gateway routes

Configure **Remote gateway** with the gateway URL, token, and dashboard URL.
**Test gateway** checks authenticated model listing; **Import model aliases**
adds routes using `provider: "google"`, `apiFormat: "google"`, and `gateway: true`.
Imported routes retain advertised context/output limits and image/thinking
capabilities. The default imported context window is `128000`; unspecified
image/thinking capabilities default to false. Re-import to refresh alias metadata.

The saved connection is `~/.gemini/antigravity/gateway_connection.json`. Changing
the gateway origin requires entering its token again. See the [gateway guide](../gateway/README.md)
for setup, network listeners, tunnels, and the gateway's separate configuration.

## Google Cloud Code account pools

Choose **Google Cloud Code account pool** and enter an available model ID. Add
an account before using **Fetch provider models**; discovery uses an enabled
account. The pool is separate from the application's vendor-managed sign-in.
Multi-account selection and automatic switching are already supported. This
provider requires your own OAuth client or explicitly imported credentials; it
does not sign into or switch the IDE's native Google session.

1. Create your own Google OAuth client with application type **Desktop app** and configure consent/test users for your project. Enter its client ID and optional client secret under **Sign in with your OAuth client**.
2. Click **Sign in with Google**. This explicitly opens the browser using Google's [installed-app OAuth flow](https://developers.google.com/identity/protocols/oauth2/native-app), with PKCE, state validation, and a temporary loopback callback. The requested scope is `cloud-platform`. You can cancel; the login attempt times out after two minutes.
3. Repeat **Sign in with Google** for each account you want to add, then save the model within **10 minutes**. Pending credentials remain in main-process memory until saved; the renderer receives masked fields. Repeat sign-in if an unsaved entry expires.
4. Alternatively, use **Import account credentials** for your own `authorized_user` JSON, an account object, or an array. Import itself makes no network requests. Save the model to retain the credentials encrypted.
5. Use **Test account** to check authorization and retrieve a quota snapshot. **Pool status** shows current state. Quota refresh is explicit, not periodic.

Each account has a unique stable `id`, optional `label`, `enabled`, `project`,
`clientId`, `clientSecret`, `refreshToken`, `accessToken`, and `expiresAt` (Unix
milliseconds). Up to 50 accounts are supported. Keep the ID unchanged when
editing masked credentials. Account `project` overrides `googleProject` when set.

`googlePool.strategy` accepts `round-robin`, `least-loaded`, `quota`, or `adaptive`.
Adaptive selection compares two eligible candidates using measured time to
response headers, in-flight load, recent failures and fresh known quota. Pool
status exposes request/success/failure counts and measured latency. Measurements
and quota snapshots become stale after ten minutes; unknown values remain unknown.
Remaining-quota selection uses the latest fresh retrieved snapshot. Conversation
affinity can retain an eligible account. `maxConcurrency` is per account
(`1`–`100`, default `2`); `cooldownMs` defaults to `60000` and accepts
`1`–`3600000`. Access tokens refresh as needed; failed authorization and
cooldown/concurrency state can temporarily make an account unavailable.

Structured Google `RetryInfo` / `ErrorInfo` hints and `Retry-After` take precedence
over the configured cooldown (bounded to 31 days). Cooldowns use the upstream
model ID, so local effort variants share the same limit. A cooldown does not
block a different upstream model using that account; authentication failures and
concurrency capacity remain account-wide. A quota snapshot disables an account
globally only when all returned fresh buckets explicitly report zero. One empty
Claude bucket must not disable a positive Gemini bucket. No refill time is guessed.

No third-party OAuth client credentials are bundled, and no browser/IDE/gcloud
credentials are automatically extracted. Successful OAuth does not grant Cloud
Code entitlement, model access, or quota. Supply an eligible account/project;
Google's location and service-access decisions remain in effect.

### Native sign-in and account access errors

Native Antigravity sign-in remains in the [IDE's own setup](ide.md#check-configure-and-launch).
There is no client-free native sign-in integration in this account pool. As of
**2026-10-14**, the official [Antigravity CLI authentication guide](https://antigravity.google/docs/cli/install)
describes the CLI's own account sessions, while the [SDK guide](https://antigravity.google/docs/sdk/overview)
documents Gemini API keys and Google Cloud credentials. Neither guide documents
an OAuth client/grant for this proxy to reuse native consumer sign-in.

Google also documents that [consumer access to the former Gemini Code Assist and Gemini CLI ended on June 18, 2026](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals).
The remaining [Code Assist service requires Standard or Enterprise access](https://docs.cloud.google.com/gemini/docs/codeassist/troubleshoot).
This is distinct from [Antigravity's individual plans](https://antigravity.google/pricing).
A successful OAuth exchange alone does not establish eligibility for either service.

| Result | Meaning and next step |
| --- | --- |
| **401** | Authorization was rejected. Reconnect the account with its OAuth client. |
| **403** | Access was denied. Check the endpoint, account/project permissions, enabled services and eligibility. During OAuth, also check consent/test-user settings. A 403 alone does not prove an Enterprise subscription is required. |
| **429** | A rate or quota limit was reached. The pool respects the provider's retry/reset hints and can try another eligible configured account before output starts. |
| **503** | The provider is temporarily unavailable or overloaded. Retry later; another account may encounter the same provider-wide demand. This is not evidence of invalid credentials or exhausted personal quota. |

See [Google's error reference](https://ai.google.dev/gemini-api/docs/api-errors).
**Pool status** distinguishes access failures from transient cooldowns. Account
tests and discovery retain the HTTP status even if the provider returns an HTML
error page; provider error bodies are not echoed into diagnostics. If access
still fails, include the application version, selected provider, endpoint host/path
and the safe error message in an issue. Omit URL queries, account identifiers,
API keys, tokens, OAuth client secrets and authorization headers.

## Effort variants and recent models

Choose **Effort variants** on a saved model to review and create low/medium/high
copies. OpenAI-compatible models receive `reasoningEffort`; other formats also
receive thinking budgets of 1024/4096/8192 and sufficient output budgets. Confirm
your provider supports these values. The source model stays unchanged, name
collisions get numbered suffixes, and saved credentials are copied privately.
No provider request occurs when creating variants.

The model manager orders recently successful models first within its grouping.
This history is process-local and excludes generation tests. It does not change
native IDE picker ordering or the stored model identities.

## Direct-proxy diagnostics and generation tests

Open **Diagnostics** in the desktop addon or IDE browser manager to inspect up
to 200 recent requests, status, elapsed time and provider-reported input/output/
cached tokens. Missing usage is shown as unknown. Totals cover this bounded
in-memory window, not billing history; restarting or clearing diagnostics removes
it. Usage belongs to the final attempted model; earlier failed retry/fallback
attempts are excluded from token totals. Elapsed time covers the whole request.
Prompt text, response text, request URLs and credentials are not retained.

**Test generation (uses quota)** in the model editor sends the fixed prompt
`Reply with OK.` with a 32-token output budget, a 30-second limit, no tools,
retries or fallback models. It exercises the same request translation as normal
chat and reports whether generated text was received. Some reasoning models need
a larger minimum output budget and can fail this small test despite being usable.
**Test connection** still checks the provider's catalog/authentication without
requesting generation.

## Credentials and data

Desktop API keys, custom-header values, saved gateway tokens, and Google
access/refresh tokens and client secrets are encrypted before persistence.
Electron `safeStorage` is preferred; otherwise AES-256-GCM uses a generated local
key at `~/.gemini/antigravity/.model-credentials-key`. Keep the key with private
backups. Machine-encrypted secrets are not portable configuration; enter fresh
credentials when moving to another machine or when decryption fails.

Saved secrets appear as `********`; leaving them unchanged preserves them on
the main-process side. Changing a provider or server origin requires fresh
credentials. **Export** removes API keys, all custom headers, and Google
access/refresh tokens and client secrets. It retains ordinary settings, account
labels/IDs, client IDs, and project names. Do not put secrets in `extraBody`, URLs,
descriptions, or other ordinary fields, and review exported metadata before sharing.

The optional gateway has a separate profile at `~/.gemini/antigravity/gateway`.
Its credential configuration does not use Electron `safeStorage`; its SQLite
history stores prompts, responses, tools, and replay snapshots. Consult
[gateway data handling](../gateway/README.md#lifecycle-and-data) before sharing
that profile. Desktop model Export does not export the gateway's database.
