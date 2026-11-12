# T3 Code surface, as observed

Everything here was observed by running it, on one macOS machine, against T3 Code `v0.1.8-nightly.20261109.4399` (`t3 --version`; the in-thread MCP server reported the same version). Provider and model names are replaced with `provider-a`, `model-small` and so on. Raw captures are in `test/fixtures/`. Items marked **unverified** were not observed.

Providers used: `provider-a` (an ACP-registry agent), `provider-b` (a codex-driver agent), `provider-c` (a claudeAgent-driver agent). Twelve `t3 thread start` calls were made in total.

## 1. Runtime mode

Command: `t3 thread start <project> <message> --provider <id> --model <slug> --wait --json`.

Observed: every CLI-started thread has `runtimeMode: "full-access"` and `interactionMode: "default"`. `createdBy` is `"agent"` and `creationSource` is `"mcp"`, whereas threads made in the UI have `createdBy: "user"` and `creationSource: "web"`. On `provider-a`, `provider-b` and `provider-c` the agent created a file and ran a shell command, `--wait` exited 0 and no approval was requested.

Consequence: a script never has to answer approvals for these threads. The `--wait` exit code 2 therefore means a question to the user, not an approval. Approval-pending behaviour was **unverified**, because full-access threads never raise one.

## 2. Own thread id

Observed: the environment variable `T3CODE_THREAD_ID` holds the caller's own thread id (seen on `provider-a` and `provider-c`; the name is also present on `provider-b`). Other matching names: `T3CODE_CLI_PATH`, `T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING`, plus provider-specific ones (`CODEX_THREAD_ID`, `CODEX_SESSION_ID`, `CLAUDE_CODE_SESSION_ID`, and for the ACP agent `T3_ACP_MCP_ENDPOINT`, `T3_ACP_MCP_ENTRYPOINT`, `T3_ACP_MCP_NODE`, `T3_ACP_MCP_AUTHORIZATION`). No variable holds a project id. The MCP tool `orchestrator_capabilities` returns the caller's own id as `parentThreadId`, which matched `T3CODE_THREAD_ID`.

Consequence: a helper running inside a thread can learn its own id from `T3CODE_THREAD_ID`, and its project id only via `t3_thread_read` on that id (`thread.projectId`).

## 3. `thread show --json` shape

Fixtures: `thread-show-completed.json`, `thread-show-waiting-question.json`, `thread-show-failed.json`, `thread-show-usage-limit.json`, `thread-read-error-items.json`.

Observed:

- `show --json` returns exactly two keys: `thread` and `messages`. `thread` has the `list` fields plus `activeRunId`, `branch`, `worktreePath`, `runCount`, `pendingRequestCount`, `archived`, `titleRegeneration`. `messages` is `[{role, runId, text}]`. There are no items, no error object, no token usage.
- A thread waiting for an answer reports `status: "running"` in both `show` and `list`, with `activeRunId` set. The only field that shows it is `pendingRequestCount: 1` in `show` (the count is not in `list`). The `--wait` output reports `status: "waiting"` and exit code 2. Distinguishing a pending question from a pending approval is **unverified**; `show` has no field naming the request kind.
- A failed thread shows `status: "failed"` and nothing else. Failure text and the usage-limit state are not in `show`. They exist in the MCP tool `t3_thread_read` (`items[]`): an item with `type: "error"`, `status: "failed"`, and `title` `"Usage limit reached"` or `"Provider turn failed to start"`. The reset time is only in the `text` prose (`... try again at Nov 9th, 2026 11:58 AM.`). The agent that read the thread found no `usageLimitExceeded` string in any item text, so that code is only in the internal database payload, not reachable through the CLI or MCP.
- Token usage appears nowhere in `show`, `list`, `--wait` output or `t3_thread_read` item keys. (Usage cache files exist under the T3 data directory; not examined.)

Consequence: classify failures by `status` plus, when needed, a `t3_thread_read` call from inside a thread and a match on the error item title. Parse the reset time from prose, treat that as best effort, and do not depend on token counts.

## 4. MCP tools from inside a thread

Observed, on all three providers: the `t3-code` server advertised 71 tools through `tools/list`, including `orchestrator_capabilities`, `t3_thread_launch`, `t3_thread_send`, `t3_thread_wait`, `t3_thread_read`, `t3_thread_list`, `t3_thread_interrupt`, `t3_thread_search`, `t3_pending_request`, `t3_queue`, `schedule_task`, `delegate_task`, `create_threads`, `t3_worktree_*`, `t3_project_*`. The codex and claude agents see them with prefixes (`mcp__t3_code__...`, `mcp__t3-code__...`).

`orchestrator_capabilities` returns `parentThreadId`, `inheritedProviderInstanceId`, `inheritedModel`, `inheritedOptions`, `runtimeMode`, `interactionMode`, `providers[]` and `features`. Each provider has `providerInstanceId`, `driverKind`, `displayName`, `models[]` (`id`, `options[]`), `canRunChildTask`, `canRunCrossProviderChildTask`, `constraints[]` (for example "Provider instance is disabled."). Features seen: `appOwnedSubagents`, `asyncPolling`, `cancellation`, `batchThreadCreation`, `threadManagement`, `incrementalThreadRead`, `scheduledTasks`, `maxBatchThreads: 20`. ACP-registry providers report `models: []`, so their valid slugs cannot be learned from it (see Surprises).

Interrupt: thread A called `t3_thread_interrupt` on thread B, which was running `sleep 240`. The result was `{threadId, runId, status: "interrupt_requested"}`. Thread B was `status: "interrupted"` with `activeRunId: null` right away (run `completedAt` 0.83 s after the call); its run status was also `interrupted`. The interrupt works across providers within a project (tested on one provider only).

Consequence: interrupt is only available to an agent inside T3, so an orchestrator helper must be driven from a thread (or the UI), not from the CLI.

## 5. Sandbox reach

Commands run from inside a thread on each of the three providers:

| Check | Result |
|---|---|
| `command -v node` | yes (a Node 24 binary under `~/.local/bin`) |
| `node -v` | yes (v24.x) |
| `command -v t3` | **no**, exit 1, no output, on all three |
| `ls ~/.t3/bin/t3` | yes |
| `mkdir -p ~/.t3orq && touch ... && rm ...` | yes |
| `git ls-remote <public-repo-url> HEAD` | yes |

There was no sandbox denial on any of these. The agents reported `T3CODE_CLI_PATH` as pointing at the CLI.

Consequence: a tool invoked from a thread must call `~/.t3/bin/t3` (or `$T3CODE_CLI_PATH`) by absolute path, may keep state under `~/.t3orq`, and can reach the network.

## 6. Sending to a busy thread

Setup: a thread running `sleep 60`; two `t3 thread send` calls while it ran.

Observed: both calls exited 0 and printed `{threadId, link, messageId, runId, status: "queued", delivery: "queued"}`, with run ordinals 2 and 3. While busy, `show` reported `status: "running"`, `runCount: 3` (the queued runs are counted) and only the first user message in `messages`. After the first run finished, the two messages ran in order as separate runs (replies to each, nothing merged or dropped), and the thread ended `completed` with `runCount: 3`. Nothing in `list` marks the queue.

Consequence: sending to a busy thread is safe and ordered, but `runCount` greater than completed runs is the only sign of a queue.

## 7. Worktree

Command: `t3 thread start <project> <message> --provider <id> --model <slug> --worktree main --branch orq/probe-1 --wait --json`.

Observed: the worktree was created at `~/.t3/worktrees/<project-title>/<branch-with-slashes-replaced-by-dashes>-<16 hex chars>`. The branch `orq/probe-1` was created and checked out in it (`git worktree list` from the main repo shows both). `show --json` exposes `branch` and `worktreePath`; `list --json` does not. `parentThreadId` stays `null`. The worktree is a clean checkout: only tracked files were present, and an untracked file and a git-ignored file from the main working copy were both absent.

Consequence: read `worktreePath` from `show` after starting. Anything not committed (local config, ignored files, dependencies) must be recreated in the worktree.

## 8. Concurrency on one instance

Observed: two threads started at the same moment on `provider-a` both ran at once (both `running` after 8 s), with no error. Higher concurrency was not tested, and the "Session already has an active Turn" error was never seen.

## 9. `--wait --json` output

One JSON object: `{threadId, runId, status, reply, error}`.

- Success (exit 0): `status: "completed"`, `reply` text, `error: null` (`thread-start-wait-success.json`).
- Failure (exit 1): `status: "failed"`, `reply: null`, `error` text such as `The agent did not accept the model "<slug>". Choose another model for this provider, then retry.` A second failure form was `Failed to open acpRegistry provider session provider-session:...` (`thread-start-wait-failure.json`). A human line (`Thread ... stopped with status failed: ...`) is also printed; whether it goes to stderr or stdout was **unverified** (output was captured merged).
- Waiting (exit 2): `status: "waiting"`, `reply: null`, `error: null` (`thread-start-wait-waiting.json`).
- Without `--wait`: `{threadId, projectId, runId}` (`thread-start-nowait.json`).

## 10. Version

`t3 v0.1.8-nightly.20261109.4399`

## Surprises that affect design

- Model slugs for ACP-registry providers are not discoverable through `capabilities`. A valid slug was only found by querying the agent's ACP session options directly. Here the accepted slug had a variant suffix (`m:<vendor>:<model>:v:thinking`); the same slug ending in `:v:` made the session fail with `Failed to open acpRegistry provider session`, and a bare model name failed with "did not accept the model". A script should treat a model as untested until a trivial thread completes with it.
- `status` in `list`/`show` never says "waiting"; use `pendingRequestCount` or the `--wait` result.
- One claude-driver thread returned a context-compressed `orchestrator_capabilities` payload (rows replaced by a placeholder marker). This comes from a compression layer in the local setup, not T3, but it means a captured capabilities result should be validated for completeness.
- The failed and usage-limit information lives only in `t3_thread_read` items, not in the CLI.
