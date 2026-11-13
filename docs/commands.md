# Commands

Run `orq` as `node ~/.t3orq/kit/bin/orq.mjs`. Project commands act on the current directory and its `.orq/`.

| Command | Purpose |
|---|---|
| [`init`](#init) | Set up this project: detect T3, slots and checks |
| [`sync`](#sync) | Merge `orchestrator_capabilities` output into the registry |
| [`instance`](#instance) | List provider instances, or keep one out of automated use |
| [`model add`](#model-add) | Add a model a provider does not list |
| [`tier set`](#tier-set) | Correct a model's tier |
| [`route`](#route) | Show which models a job class routes to |
| [`config`](#config) | Read or change project or machine settings |
| [`plan check`](#plan-check) | Validate `.orq/plan.json` |
| [`plan archive`](#plan-archive) | Put a finished plan away so the next request starts a fresh one |
| [`wait`](#wait) | Run the plan until something needs the orchestrator |
| [`status`](#status) | The plan, slots and one line per unit |
| [`unit`](#unit) | Retry or drop a unit after judgment |
| [`review`](#review) | Start or read a review of the integrated result |
| [`ask`](#ask) | Get a decision from the strongest enabled model instead of the user |
| [`summary`](#summary) | Write the pull request body |
| [`settle`](#settle) | List finished threads to settle in T3 |
| [`probe`](#probe) | Print the machine cap and why |
| [`version`](#version) | Print the `orq` and kit versions |
| [`update`](#update) | Move the kit to a release |
| `help` | List commands (also `--help`, `-h`, or no arguments) |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Error; the message follows `orq:` on stderr |
| 2 | Usage error: unknown command, unknown option or missing argument |
| 3 | `init` or `ask` was run inside a worker thread |
| 4 | Refused or nothing to do: invalid plan, no route, tier owned by the user, unit busy, review not possible, update refused |
| 5 | Another `orq wait` is running for this project |

## init

`orq init`

This command records the `t3` binary and its version. It resolves the capability slots from commands on `PATH`, and detects check commands from the project files. It adds `.orq/` to the repository's local exclude file. Checks you have set, even to `null`, are never overwritten.

```
t3=<version|missing> cap=<n> kit=<sha|unknown>
slots: judge=<name> memory=<name> code-index=<name> git-host=<name>
checks: setup=<cmd|none> full=<cmd|none>
autonomy=<draft|review-fix|review-fix-merge|unset> questions=<auto|user>
registry: <n> instances, <n> models, synced <n>h ago|never
next: pipe orchestrator_capabilities JSON to "orq sync"
```

The `next:` line appears when the registry has never been synced or is more than 12 hours old. Exit 3 with `this thread is a worker started by orq; follow your work order` when a lease exists for the calling thread.

## sync

`orq sync < capabilities.json`

This command reads JSON on stdin: either the `orchestrator_capabilities` result, or `{"capabilities": <that result>, "tools": [<tool names>]}`. It merges providers and models into the registry and harvests models proven by completed threads in this project. With `tools`, it also resolves the MCP-based slots. Tiers set by you or the orchestrator are never overwritten. Instances you disabled stay disabled. When the payload names the orchestrator's own model (`inheritedProviderInstanceId` and `inheritedModel`), it is recorded in `.orq/config.json` as `orchestrator: {instance, model, threadId}` (`threadId` from `parentThreadId`, the caller's own thread), so `orq ask` called from that thread knows when no stronger model exists. A payload without those fields removes the record.

```
+instances: <ids>
-instances: <ids>
enabled: <ids>
+models: <n>
unavailable: <n>
synced: <n> instances (<n> enabled), <n> models (<n> confirmed)
inferred: <keys> — set with: orq tier set <key> <1-4>
```

Lines with nothing to report are left out. `inferred:` lists at most 8 keys, then `+<n> more`. Exit 2 when stdin is empty or over 8 MiB. Exit 1 when the JSON is invalid or the capabilities look truncated.

## instance

`orq instance list | orq instance disable <id> | orq instance enable <id>`

`list` prints one line per instance:

```
<id> on|off-user|off-t3 models=<n>[ cooldown_until=<iso time>]
```

`off-t3` means T3 reports the instance disabled or did not report it. `off-user` means you disabled it, and `sync` never changes that. `disable` and `enable` print `instance <id>: disabled by user` or `instance <id>: enabled`.

## model add

`orq model add <instance> <model> [--tier N]`

Adds a model to an instance that lists none, such as an agent that reports `models: []`. Prints `added <instance>::<model> tier=<n> (<source>)`.

## tier set

`orq tier set <instance>::<model> <1-4> [--by user|orchestrator]`

Prints `tier <key> = <n> (<by>)`. `--by` defaults to `orchestrator`. A tier set by `user` outranks one set by `orchestrator`, which outranks one that was suggested or inferred. When the current tier has a higher source, it prints `unchanged: <key> is set by <source>` and exits 4.

## route

`orq route --job <class> [--author-tier N] [--author-family F] [--json]`

Lists the eligible models in the order `orq` would use them:

```
1 <instance> <model> tier=<n> family=<family> confirmed|unconfirmed[ same-family][ below-tier]
```

`review` and `fix` need the author's tier, and `review` also needs the family. If the project has integrated units, the values come from the ledger. Exit 4 with `none blocked=<excluded|cooling|limit|mixed|empty> retry_at=<iso time|-> reason="<why>"` when nothing is eligible.

## config

`orq config get [--machine] | orq config set [--machine] <key> <value>`

`get` prints the config as JSON. `set` prints `<key> = <value>`. The value `null` clears `autonomy`, `cap` or a check. `pollSeconds` is at least 5. `questions` is `auto` (the default: `orq ask` lets the strongest enabled model decide) or `user` (every question goes to the user).

| Scope | Keys |
|---|---|
| project (`.orq/config.json`) | `autonomy`, `base`, `checks.setup`, `checks.unit`, `checks.full`, `pollSeconds`, `stallMinutes`, `gateConcurrency`, `leaseTtlMinutes`, `questions` |
| machine (`~/.t3orq/config.json`) | `cap`, `perInstanceLimit` |

`checks.unit` runs in every unit's gate after the evidence. `checks.full` runs once on the integration head.

## plan check

`orq plan check [--json]`

Prints `plan ok: <n> units, order: <ids>`, or one `error: <problem>` line per problem and exit 4. Before `plan ok` it prints `warning: <unit>: evidence runs a file outside the repository (<paths>); a check belongs in the repository, written by a unit` for a unit whose evidence names a file under `.orq/`, or an absolute path (`/…`, `~/…`) outside the project that is a command word or ends in a file extension; paths under system locations (`/usr`, `/bin`, `/sbin`, `/opt`, `/nix`, `/snap`, `/dev`, `/proc`, `/sys`, `/etc`, `/System`, `/Library`, `/Applications`) are not counted. A warning never changes the exit code; `orq wait` repeats it once per call. `--json` adds a `warnings` array. A unit may set `"setup": false` (boolean, default `true`) to skip `checks.setup` in its own gate; any other value is an error. Exit 1 when there is no plan. It checks the schema, job classes, unit ids, dependencies and cycles. It also checks that each work order is a file under `.orq/` of at most 40 lines, and that units which could run in parallel have non-overlapping `paths`.

## plan archive

`orq plan archive`

Each request gets its own plan, ledger and integration branch. This moves the current plan's state (`plan.json`, `ledger.jsonl`, `units/`, `orders/`, `reviews.json`, `summary.md`) into `.orq/archive/<planId>/`, removes the integration worktree when it is clean, and keeps the integration branch. It also removes the worker and review worktrees (every worktree on an `orq/*` branch, including leftovers of earlier plans) with a plain `git worktree remove`; one with uncommitted or untracked files, or a locked one, is kept and reported in a `note: kept worktree` line. No branch is ever deleted. Config, memory and capabilities stay. The next `plan.json` starts a new plan cut from the configured base.

It refuses, with exit 4, while anything is in flight: a unit that is running, blocked, gating or passed but not merged, a running gate or review, a running `orq wait`, or an integration worktree with uncommitted changes. Units that were never integrated do not block it; it lists them in a note.

```
archived: plan <planId> (<n> integrated, <m> not) -> .orq/archive/<planId>/
integration branch kept: <branch>
```

While an archive is in progress the project is frozen: it writes `.orq/archiving.json` first, and every other command that touches plan state refuses until the archive finishes. If it was interrupted, run it again; nothing is deleted until the archived ledger matches the live one. If it can never finish, its error says how to unfreeze: deleting `.orq/archiving.json` keeps whatever plan state is still under `.orq/` in use.

## wait

`orq wait [--max-seconds N]`

This runs the scheduler for up to `N` seconds (default 480). The first line it prints is one of `done:`, `final-fail:`, `judgment:`, `blocked:`, `idle:` or `timeout:`. It exits 0 for each of them. When threads orq started are done for good and still unsettled in T3, the second line is `settle: <threadId> <threadId> …` (at most 20 ids, then `+<n> more`); notes and detail lines follow. See [Scheduling](scheduling.md#what-orq-wait-returns). Exit 4 when the plan is invalid or uses the reserved unit id `integration`. Exit 1 when no usable `t3` is recorded. Exit 5 when another `orq wait` holds this project.

## status

`orq status [--json]`

```
plan: <goal> (<planId>|not started)
integration: <branch> head=<sha> base=<sha>
cap=<n> active=<n> blocked=<n> gates=<n> machine_leases=<n>[ expired_leases=<n>]
<unit> <state>[ attempt=<n>][ model=<key>][ tier=<n>][ wanted_tier=<n>][ continued][ thread=<id>][ flags=<kinds>][ <reason>]
authors: max_tier=<n> family=<family>
cooling: <instance> until <iso time>, …
note: cap covers threads orq started; threads started by hand are not counted
```

When the machine `cap` is an override above what the machine computes, a line `note: cap <n> is an override; this machine computes <m> (<reasons>)` comes before the last note; `orq wait` prints the same note once per call. A line `ask: decision <n> running thread=<id> model=<key>` follows the `authors:` line for each decision thread still running. The `integration:`, `authors:`, `ask:` and `cooling:` lines appear only when they apply. `wanted_tier` appears when the unit was launched below its minimum tier because no model at that tier was usable.

## unit

`orq unit retry <id> [--tier N] | orq unit drop <id>`

`retry` moves a `failed` unit back to `queued` and clears its attempts, its excluded models and its provider failure count. `--tier` sets a minimum tier (1-4). It prints `retried <id>: queued[, minimum tier <n>]`. A unit that failed because `checks.setup` failed goes back to `gating` instead, to gate its branch again; it prints `retried <id>: its branch will be gated again`. `--tier` is refused for such a unit (exit 1), since no new worker runs. `orq unit retry integration` runs the final gate again when it could not complete, when its setup failed, or when its checks failed (`final-fail:`); it uses the current `checks.full`.

`drop` removes a unit from the run and prints `dropped <id>`. If its thread was running, a note says it keeps running in T3. Dropping is refused, with exit 4, while the unit is being gated or merged, and while a unit that is not dropped depends on it: `cannot drop <id>: <ids> depend on it; drop them first, or remove "<id>" from their deps in .orq/plan.json`.

## review

`orq review start [--order <file>] | orq review show [<n>]`

`start` needs at least one integrated unit. It routes job `review` on the author's tier and family. Then it starts a thread on the integration head, on branch `orq/<planId>/review-<n>`, with the order file as its first message. The order file defaults to `.orq/orders/review.md`, must be under `.orq/orders/`, and is at most 40 lines. It prints `review <n>: thread=<id> model=<key> head=<sha>`. When no model is eligible it prints the same `none …` line as `route` and exits 4.

`show` reads the latest review, or review `n`. It prints `review <n>: running`, or `review <n>: completed` followed by the reviewer's last message, quoted: each line indented two spaces, control characters removed, at most 300 characters per line and 40 lines (the last then says `… <n> more lines`). A failed review (its thread ended failed, cancelled or interrupted) is replaced at once on another model, with the same order and head, and prints `review <n>: failed on <key>; replaced by review <m> on <key> (thread <id>)` (exit 0); the failed review's lease is released. At most two replacements are made for one review; after that, or when no other model is free, it prints `review <n>: failed; run "orq review start" again` and exits 4.

## ask

`orq ask [--unit <id>] [--max-seconds N] < question | orq ask --show [<n>]`

Gets a decision without the user. The question is read from stdin (required, at most 16 KiB; exit 2 otherwise). The orchestrator acts on the first line printed (at most 160 characters after the word). Up to 29 lines of the deciding model's reasons follow it, each indented two spaces and cut at 160 characters, with control characters and Unicode line breaks removed, so no line of the reply can pose as an orq line. The exit code is 0 for every outcome below; only usage errors (exit 2) and the worker guard (exit 3) exit otherwise.

| First line | Meaning |
|---|---|
| `answer: <decision>` | The deciding model decided. Act on it. |
| `escalate: <question>` | The deciding model says only the user can decide (data loss, money, publishing beyond the autonomy mode, a secret). Ask the user in your own thread. |
| `escalate: no decision (<why>)` | No decision was made: `no model: <reason>`, `no free machine slot`, `start failed on <key>`, `the decision thread failed`, `the reply had no ANSWER or ESCALATE line`, `no usable t3; run "orq init"`, `no checkout to read: …`, `decision <n> never started`, `decision <n> is not in this plan`, `no decision in this plan`, or the first line of any other error (an unreadable `.orq/` file, an archive in progress). Ask the user in your own thread. |
| `user: questions are set to user` | `questions` is `user`. Ask the user. No thread is started. |
| `self: you run on the strongest enabled tier; decide it yourself` | The caller is the thread `orq sync` recorded (`T3CODE_THREAD_ID` equals the recorded thread id) and its model has a tier at least as high as every enabled model. No thread is started. |
| `pending: decision <n> still running; run "orq ask --show <n>"` | `--max-seconds` (default 300) passed while the decision thread runs. |

The decision thread routes job `decide`: tier 4, strongest first. When no tier-4 model exists, or all are cooling down or at their limit, the strongest free model decides instead (its key and tier are recorded and shown in the summary); `no model` means nothing at all is routable. When a decision thread fails, or does not start, the next `decide` candidate is tried (the failed models are excluded and their instances avoided), at most 3 threads per ask within `--max-seconds`; each try is a record in `.orq/asks.json`. Only then does it print `escalate: no decision (<last reason>; tried <key>, …)`. It holds a machine lease while it runs. When every slot is held it waits for one within `--max-seconds`, then prints `escalate: no decision (no free machine slot)`. Its first message is `playbook/templates/decision-order.md`, then `## Question (data)`, `## Plan (data)` (goal and decisions, when a plan exists) and, with `--unit`, `## Unit (data)` (id, title, paths and the work order; an unknown id is exit 2). Each section's text is inside a code fence longer than any backtick run in it, so a heading or a rule inside a question cannot change the order's rules. It runs on the integration head on branch `orq/<planId>/ask-<n>` once the plan has started, else on the configured base on branch `orq/ask-<n>-<time>`. The decision's number is reserved in `.orq/asks.json` (status `starting`) before the thread starts, so concurrent asks never share a branch or a lease. `.orq/asks.json` records each decision (`starting`, `running`, `answered`, `escalated` or `failed`, with the model's key and tier), and `orq plan archive` moves it with the plan; a decision still running then gets a `note: decision <n> is still running in thread <id>; its outcome will not be recorded` line.

`--show` looks at decision `n` (default: the latest) once and prints the same lines; it records an outcome only once. A decision still `starting` prints `pending:` until its asker's deadline, then `escalate: no decision (decision <n> never started)`. A decision that is not in `.orq/asks.json` (for example archived) prints `escalate: no decision (decision <n> is not in this plan)`. Exit 3 inside a worker thread, as for `init`.

## settle

`orq settle [--all]`

Lists the threads `orq` started that are done for good and that T3 reports as not settled, one per line: `<threadId> unit <id> integrated|dropped|replaced`, `<threadId> review <n>` or `<threadId> decision <n>`. It prints `nothing to settle` when there are none, and exits 0. `--all` also covers the archived plans under `.orq/archive/`. T3 has no CLI command to settle a thread: the orchestrator settles each listed id with its `t3_thread_organize` tool (`action: "settle"`). It calls `t3 thread list` once, outside any lock. `orq plan archive` prints `settle: run "orq settle --all"` when archived plans leave such threads.

## summary

`orq summary [--out <file>]`

Writes the pull request body to `.orq/summary.md`, or to another `.md` file directly under `.orq/`. The body has these sections: goal, decisions, decisions taken without you (answered `orq ask` decisions: question → answer and the model; omitted when there are none), a unit table, evidence results, final checks, reviews, and units not done. It prints `summary: <file> (<n> lines)`. Exit 4 when the plan has not started.

`orq summary --plan <planId>` prints the summary of an archived plan and writes nothing.

## probe

`orq probe [--json]`

Prints `cap=<n> cores=<n> mem_gb=<n> load1=<n> reasons="<why>"`.

## version

`orq version`

Prints `orq <package version> kit=<sha|unknown>[ tag=<tag>]`. `orq --version` prints the package version alone.

## update

`orq update [--to <tag|sha>] [--check]`

This fetches the kit's `origin` and moves the kit checkout to the highest `vX.Y.Z` tag, or to `--to`, which must be a full 40-hex commit SHA or an existing tag. It refuses, with exit 4, when the kit has local changes, is not a git checkout, has no release tag yet, or its origin cannot be reached.

It does not move backwards on its own. When the target is not ahead of the current commit, for example a development clone that is past the latest tag, it refuses and tells you to pass `--to`. With `--to` it moves anyway and prints `moved (not a fast-forward): <old> -> <new>` in place of `updated:`.

The kit's origin is trusted and tags are not signature-checked. The commit pinned in the stub is the trust anchor; `update` is a convenience.

```
updated: <old sha> -> <new sha>[ (<tag>)]
review the changes: git -C <kit dir> log --oneline <old>..<new>
```

With `--check` it changes nothing, works even when the kit has local changes, and prints `update available: <old> -> <new>[ (<tag>)]` or `would move (not a fast-forward): <old> -> <new>`. Either way, it prints `up to date at <sha>` when there is nothing to do.
