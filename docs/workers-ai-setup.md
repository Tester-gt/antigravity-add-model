# Cloudflare Workers AI setup

The optional CLI discovers your account, helps select Workers AI models and saves their token through the application's encrypted model store. You can use an existing token or explicitly create one account-scoped **Workers AI Write** token. It never creates token managers or automatically revokes old tokens.

Build once with `npm ci --ignore-scripts` and `npm run build`, then open a terminal in this repository:

```powershell
npm run workers-ai:setup -- wizard
```

On Windows PowerShell, use `npm.cmd` if the `npm.ps1` wrapper consumes command options. You can also run `node scripts/workers-ai.mjs wizard` directly; `node scripts/workers-ai.mjs --help` shows all options.

The wizard asks whether to use an existing token or create a scoped token. Token input is masked. Choose an account and model numbers; model capabilities come from the existing discovery implementation. Unknown context, vision and output limits remain unset instead of receiving guessed values. Existing model settings and aliases are preserved.

## Credentials and permissions

For an **existing token**, supply your 32-character Account ID and a Workers AI token. No bootstrap credential or token-management permission is requested. The Workers AI token template grants inference access; a read-only token may list models without permitting generation.

For **creation**, first create a bootstrap token in Cloudflare with **Account API Tokens Write**, limited to the account you intend to use. Automatic account discovery may additionally require account-reading access; supplying `--account-id` avoids account listing. The helper reads permission groups from the selected account and accepts only the exact **Workers AI Write** permission with the account resource scope. It does not substitute a Read permission or add token-management rights to the new token. The wizard displays the selected account and expiry and asks you to type `CREATE` before creating it.

The bootstrap token is never stored. New model credentials are encrypted using the application's existing credential store. In standalone Node, this uses authenticated AES-GCM encryption with a local user key; protect the data directory and its `.model-credentials-key` file together. Do not commit either file.

Never place a token in a command argument. Supported inputs are:

- The masked interactive prompt.
- `CF_WORKERS_AI_TOKEN` for an existing token or `CF_BOOTSTRAP_TOKEN` for creation, supplied by your environment or secret manager. The helper reads only the credential for the selected mode.
- `--token-file PATH` for existing tokens or `--bootstrap-file PATH` for creation. The file must already exist, contain only the token, be a regular nonlinked file of at most 8192 bytes, and have owner-only permissions on Unix (`chmod 600`). On Windows, restrict access using file permissions. The helper never creates a plaintext token file.

Do not combine an environment token and token file for the same mode. Token values, fragments, request bodies and raw provider errors are never printed.

## Existing token and read-only verification

```powershell
npm run workers-ai:setup -- existing --account-id ACCOUNT_ID --select "@cf/organization/model" --token-file "C:\private\workers-ai-token.txt"
npm run workers-ai:setup -- verify-only --account-id ACCOUNT_ID --token-file "C:\private\workers-ai-token.txt"
```

Replace `ACCOUNT_ID` with your account's actual 32-character hexadecimal ID. Use model IDs returned by discovery, not the example placeholder. `verify-only` checks authenticated model-catalog access for that account. It **does not create tokens, write model or credential files, or run inference**. Successful catalog access does not prove inference permission or available quota.

## Explicit creation and rotation

For automation, `create` explicitly authorizes one token creation without an interactive confirmation. Supply model IDs or `--rotate`; the token is not printed.

```powershell
npm run workers-ai:setup -- create --account-id ACCOUNT_ID --select "@cf/organization/model" --bootstrap-file "C:\private\bootstrap.txt" --expires-in-days 90
npm run workers-ai:setup -- existing --account-id ACCOUNT_ID --rotate --token-file "C:\private\replacement-token.txt"
npm run workers-ai:setup -- create --account-id ACCOUNT_ID --rotate --bootstrap-file "C:\private\bootstrap.txt" --expires-on 2027-01-01T00:00:00Z
```

Creation defaults to a 90-day expiry. Choose either `--expires-in-days` (1–365) or a future UTC `--expires-on` within 365 days. The API request uses `expires_on`, and the response must confirm that expiration.

Rotation updates entries using the selected account's official `https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1` endpoint, with or without `/chat/completions`. Other accounts, custom proxy hosts and unrelated `@cf/` model names are untouched. Disabled matching entries are included, retaining their disabled setting. Old `Authorization`, `X-Auth-Key` and `X-Auth-Email` headers are removed case-insensitively so the new encrypted API token takes effect. Other headers and model settings are preserved. Selecting an already saved upstream model also replaces its credential while preserving its aliases and settings; generated-name conflicts are rejected.

Changes are validated and written as one atomic model-store batch. No plaintext backup is created. Keep your normal protected backup if you need historical configurations. Existing tokens are not revoked; after checking the updated models yourself, revoke obsolete tokens in Cloudflare if they are no longer used elsewhere.

## Failure handling

Account and permission lists have page, size and time bounds. Requests use the fixed Cloudflare API origin, reject redirects and redact provider error bodies. Token creation is attempted once; an ambiguous network failure is never automatically retried. Inspect your account's tokens before running creation again.

If Cloudflare creates a token but discovery, selection, validation or saving subsequently fails, the error identifies the **token ID**, never its secret. That token was not installed; revoke it in Cloudflare before retrying. Cancellation after creation can also require this cleanup. Existing model files remain intact on validation/save failure. A token may have been created remotely when a process is forcibly terminated; check Cloudflare before restarting a create operation.

Use `--data-dir DIRECTORY` to target a separate model directory, and `--help` for the full command reference. The implementation is covered by isolated fake-Cloudflare tests; those tests do not claim real account access or inference success.

Official references: [Create account API token](https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/create/), [account permission groups](https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/subresources/permission_groups/methods/list/), [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/), [Workers AI](https://developers.cloudflare.com/workers-ai/).
