# Real account quota from EasyCLIProxyAPI

`orq` can route by the real quota of each account instead of guessing it from refusals. On a machine that runs [EasyCLIProxyAPI](https://github.com/router-for-me/EasyCLIProxyAPI) (a desktop GUI over [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), core v8), `orq` reads the same numbers as the GUI's Quota Lookup screen. Machines without it use the snapshot a peer publishes. When neither is available, routing works as before: T3's own usage readings and the provider's refusals ([Account usage](scheduling.md#account-usage)).

`orq` only reads. It never starts, stops or reconfigures EasyCLIProxyAPI, and never touches its OAuth files.

## What the management API exposes

This was checked against the CLIProxyAPI source at tag `v8.0.78` (`internal/api/server_management.go`, `internal/api/server_management_v8.go`, `internal/api/handlers/management/{auth_files.go,api_tools.go,plugin_quota.go,quota.go}`, `docs/management-api-v8.md`) and against EasyCLIProxyAPI's `src/services/quotaService.ts` and `pluginCredentialQuota.ts` (main, 2026-11).

- **Access.** Base paths are `/v0/management` (still supported) and `/v8/management`. Every request sends the management key as `Authorization: Bearer <key>` or `X-Management-Key: <key>`. With `allow-remote: false` (the default) only localhost may call it.
- **Where the key is.** The GUI keeps it in plain text as `management-secret-key` in `~/Library/Application Support/com.cpa.gui/config.toml`, next to `port` (8317) and `host` (127.0.0.1). The core's own `cpa-core/config.yaml` stores only a hash of it, so the GUI file is the one to read. `orq` holds the key in memory for the request and never prints, logs or stores it.
- **Accounts.** `GET /v0/management/auth-files` (v8: `GET /credentials`) lists every credential: `auth_index` (the handle for every per-account call), `name` (file name), `provider`/`type` (`claude`, `codex`, `antigravity`, `xai`, `kimi`, `gemini`, …), `email`, `account`, `label`, `project_id` (antigravity), `status`, `disabled`, `unavailable`, `next_retry_after`, `success`/`failed` counts, `recent_requests`, and `quota`: only passive observations (`observed_at` and the provider's rate-limit response headers as `signals`). The proxy deliberately leaves its own cooldown state out of it, and providers other than a few report nothing there, so it is not a quota reading.
- **Quota per account.** The core has no built-in quota endpoint for the OAuth providers. `POST /v0/management/quota/fetch` and `/plugins/<id>/quota` answer only when a quota plugin is installed (normalized `groups[].buckets[]` with `remainingFraction` and `resetTime`, `summary[]` metrics, `subscription.plan`), otherwise `501 no quota provider available`. The GUI's Quota Lookup instead calls each provider's own usage endpoint through `POST /v0/management/api-call` (v8: `/requests/api-call`) with `{auth_index, method, url, header, data}`. The proxy fills `$TOKEN$` in the headers with that account's fresh access token (refreshing it when needed) and returns `{status_code, header, body}` with the upstream body as text. These usage endpoints report usage; they spend no tokens.

| Provider | Upstream call (through `api-call`) | What it returns |
|---|---|---|
| codex | `GET https://chatgpt.com/backend-api/wham/usage` | `plan_type`; `rate_limit.{primary_window,secondary_window}.{used_percent, limit_window_seconds, reset_at, reset_after_seconds}` (18000 s is the 5-hour window, 604800 s the weekly one); `limit_reached`; `code_review_rate_limit`, `additional_rate_limits[]`; `credits.{balance, unlimited}` |
| claude | `GET https://api.anthropic.com/api/oauth/usage` (header `anthropic-beta: oauth-2025-04-20`) | `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `seven_day_oauth_apps` each `{utilization (used %), resets_at}`; Fable as `limits[]` with `kind: weekly_scoped` (or the legacy `iguana_necktie`); cloud-session credit pools with `limit_dollars`/`used_dollars`/`remaining_dollars`; `extra_usage` |
| antigravity | `POST https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary` with `{"project": <project_id>}` | `groups[]` (`Gemini Models`, `Claude and GPT Models`, a model's own group) each with `buckets[]` `{window: "Five Hour Limit Remaining" / "Weekly Limit Remaining", remainingFraction, resetTime}` |
| kimi, xai | `api.kimi.com/coding/v1/usages`, `cli-chat-proxy.grok.com/v1/billing` | listed by `orq` with no windows for now: no orq instance runs on them |

The plan names (`Pro`, `Max`) the GUI shows come from further calls (`/api/oauth/profile`, `loadCodeAssist`); `orq` reads codex's `plan_type` only.

## What orq does with it

`lib/easycli.mjs` reads the GUI config, lists the accounts and asks the providers above in parallel (8 s per request). Disabled credentials and providers it does not know are skipped. Each account becomes `{provider, account (e-mail), plan, windows: [{name, remainingPct, resetsAt}], credits}`. Window names are short and stable: `5h`, `weekly`, `monthly`, `code-review-weekly` (codex), `weekly-opus`, `weekly-fable` (claude), and for antigravity the pool T3 itself uses, `gemini-5h`, `gemini-weekly`, `3p-weekly` (Claude and GPT), `gemini-argon-weekly` (a model's own pool). A failed account (an expired token: `upstream 401`) has no windows; EasyCLI not answering is no snapshot. Neither is an error.

`lib/quota.mjs`:

- **Refresh.** `orq wait` asks at most every 5 minutes, on its poll, outside every lock. The last good snapshot and the time of the last try are kept in `~/.t3orq/quota.json`. A snapshot older than 20 minutes is not used.
- **Accounts to instances.** An instance takes an account when its T3 display name is the account's e-mail or the e-mail's local part, on a driver of the account's provider (codex on `codex`, claude on `claudeAgent`, antigravity on `antigravity`, xai on `grok`, kimi on `acpRegistry`). So an instance codex-2 named `alice.dev` takes the codex account `alice.dev@example.com`, and claudeAgent-2 named `alice.dev01` the claude account `alice.dev01@example.com`, without configuration. Two accounts with one local part are not guessed. `quotaSource.accounts` in the machine config maps an instance explicitly (`{"codex-3": "alice.dev01"}`, an e-mail or its local part; the instance's own provider wins, then any, for a proxy instance).
- **Routing.** A mapped account's windows replace T3's readings for that instance (T3's signed-out and error flags stay) and go through the same rules as T3's ([Account usage](scheduling.md#account-usage)): headroom is what is left of the fullest window that binds the model; a window at or over `usageThreshold` used (95 means 5% or less left, 0% always) cools the models it binds until its reset; a limit hold the provider set ends early once a reading taken after the settle time shows room, now on every provider, not only Antigravity.
- **Credits.** An instance in `creditInstances` keeps routing past its windows as before, unless EasyCLI read its credit balance as 0: then its windows count.
- **Peers.** The machine that reads EasyCLI publishes the snapshot in its peer status (`orq peers --self`, `~/.t3orq/peers/self.json`). A machine with no EasyCLI config asks its `peers` (the same ssh and cache as before) and routes by the freshest snapshot under 20 minutes old, mapped to its own instances by the same rules. A peer's snapshot is rebuilt field by field: known provider names only, account and window names of a strict character set, numbers. With no peer reachable it routes as before.

## Configuration

Nothing is needed on the machine that runs EasyCLIProxyAPI at the default path. The machine key `quotaSource` (one JSON value) changes it:

```
orq config set --machine quotaSource '{"configPath": "/Users/me/Library/Application Support/com.cpa.gui/config.toml"}'
orq config set --machine quotaSource '{"url": "http://127.0.0.1:8317", "accounts": {"codex-3": "alice.dev01"}}'
orq config set --machine quotaSource '{"kind": "off"}'
orq config set --machine quotaSource null
```

`url` overrides the address read from the GUI config; the key always comes from the file. A machine that reads its quota from a peer needs that peer in `peers`.

`orq usage` prints the table (`--refresh` asks EasyCLI now, `--json` prints the snapshot):

```
quota: from easycli, 2 min old
codex alice.dev@example.com -> codex plan=pro: 5h 72% left (resets in 2h0m), weekly 40% left (resets in 2d2h) credits=12.5
antigravity shop@example.com -> antigravity-2: gemini-5h 75% left (resets in 2h50m), gemini-weekly 0% left (resets in 3d3h), 3p-weekly 84% left (resets in 3d3h)
```
