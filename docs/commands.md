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
| [`inbox`](#inbox) | Leave a message for the orchestrator's next `orq wait` |
| [`status`](#status) | The plan, slots and one line per unit |
| [`unit`](#unit) | Retry or drop a unit after judgment |
| [`review`](#review) | Start or read a review of the integrated result |
| [`ask`](#ask) | Get a decision from the strongest enabled model instead of the user |
| [`stats`](#stats) | Which model did well: launches, gates, first passes |
| [`summary`](#summary) | Write the pull request body |
| [`ship`](#ship) | Continuous mode: ship the head that passed the final checks as its own pull request |
| [`settle`](#settle) | List finished threads to settle in T3 |
| [`worktree prune`](#worktree-prune) | Remove the worktrees finished work left behind |
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
| 5 | Another `orq wait` is running for this project (for `ship`: a wait, an archive or another ship) |

## init

`orq init`

This command records the `t3` binary and its version. It resolves the capability slots from commands on `PATH`, and detects check commands from the project files. It adds `.orq/` to the repository's local exclude file. Checks you have set, even to `null`, are never overwritten.

```
t3=<version|missing> cap=<n> kit=<sha|unknown>
slots: judge=<name> memory=<name> code-index=<name> git-host=<name>
checks: setup=<cmd|none> full=<cmd|none>
autonomy=<draft|review-fix|review-fix-merge|continuous|unset> questions=<auto|user>
share: <paths>|none[ (<why not>)]
registry: <n> instances, <n> models, synced <n>h ago|never
providers: <n> usable (<ids>); <n> disabled in T3 (<ids>); <n> disabled by you (<ids>); <n> cooling (<ids>)[; <n> no models listed (<ids>)]
next: pipe orchestrator_capabilities JSON to "orq sync"
```

The `next:` line appears when the registry has never been synced or is more than 12 hours old. `init` (and `sync`, which starts each session) records which playbook the orchestrator has read, per orchestrator thread: `playbooks: {<T3CODE_THREAD_ID>: {kit: <sha12>, hash: <16 hex>, at}}` in `.orq/config.json` (the hash of the running kit's `playbook/ORCHESTRATOR.md`; `kit` only when the kit is a git checkout; a caller without a thread id uses the shared record `_`, and the single `playbook` record of the previous version still counts for it). At most 10 records are kept, the most recent. Each orchestrator thread is compared with its own record, so one orchestrator's `init` does not silence the line for another. Running `init` again re-records it and changes nothing else. Exit 3 with `this thread is a worker started by orq; follow your work order` when a lease exists for the calling thread.

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
providers: … (as for init)
usage: <instance> <used>% <window>[ resets <iso time>]|down|stale|unreadable; …   (see status)
inferred: <keys> — set with: orq tier set <key> <1-4>
```

When T3 reports [account usage](scheduling.md#account-usage), `sync` prints the `usage:` line (see [status](#status)). Lines with nothing to report are left out. `inferred:` lists at most 8 keys, then `+<n> more`. Exit 2 when stdin is empty or over 8 MiB. Exit 1 when the JSON is invalid or the capabilities look truncated.

## instance

`orq instance list | orq instance disable <id> | orq instance enable <id>`

`list` prints one line per instance:

```
<id> on|off-user|off-t3 models=<n>[ cooldown_until=<iso time>]
```

`off-t3` means T3 reports the instance disabled or did not report it. `off-user` means you disabled it, and `sync` never changes that. The switch is stored for the machine, so it applies to every project that uses this kit. `disable` and `enable` print `instance <id>: disabled by user` or `instance <id>: enabled`.

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
1 <instance> <model> tier=<n> family=<family> confirmed|unconfirmed[ same-family][ below-tier][ score=<rate|-> n=<attempts>][ demoted][ headroom=<n>%]
```

`headroom` is what is left of the fullest usage window that binds the model, when T3 reports [account usage](scheduling.md#account-usage).

`review` and `fix` need the author's tier, and `review` also needs the family. If the project has integrated units, the values come from the ledger. Exit 4 with `none blocked=<excluded|cooling|limit|mixed|empty> retry_at=<iso time|-> reason="<why>"` when nothing is eligible.

## config

`orq config get [--machine] | orq config set [--machine] <key> <value>`

`get` prints the config as JSON. `set` prints `<key> = <value>`. The value `null` clears `autonomy`, `cap` (machine or project), `goal`, a check, or a scheduler key (`pollSeconds`, `stallMinutes`, `gateConcurrency`, `leaseTtlMinutes`, `finalTimeoutMinutes`: back to its default). `pollSeconds` is at least 5. `share` is a comma list of repository-relative dependency directories (`node_modules, apps/shop/node_modules`) that worktrees link from the main checkout, or `null` to turn sharing off; `orq init` detects it when the key is absent or an empty list (so a project whose dependencies were not installed yet is detected once they are; the `share:` line then reads `none (node_modules is not installed in the project root: install there once, then run "orq init" again)`): every git-ignored `node_modules` up to 4 levels deep, not inside another one, whose lockfile (next to it or at the root) is pnpm's or bun's; npm, yarn and lockfile-less projects are never shared, whatever `share` says, and `.venv`/`vendor` only when listed explicitly. The init line then reads `share: <paths>`, or `share: none (<why>)` when a `node_modules` was found but cannot be shared. Setting it rewrites `orq`'s block of anchored lines (`/node_modules`) in the repository's `info/exclude`, so a link is ignored even where `.gitignore` says `node_modules/` (a pattern that matches directories only, not symlinks); only paths git already ignores get a line, and a path git tracks files under is refused (`share: "<p>" has tracked files; only untracked, ignored directories can be shared`). See [Shared dependency directories](how-it-works.md#shared-dependency-directories). `autonomy` is `draft`, `review-fix`, `review-fix-merge` or `continuous` (see [Autonomy modes](how-it-works.md#autonomy-modes)); only `continuous` changes what `orq` itself does: the final gate rolls while units still run, and `orq ship` ships each head that passed (see [ship](#ship)). `questions` is `auto` (the default: `orq ask` lets the strongest enabled model decide) or `user` (every question goes to the user). `cleanup` is `true` (the default) or `false`: see [Cleanup](how-it-works.md#cleanup); `false` keeps the removal of a unit's worktrees at integration and at archive as in 0.9.0 (a plain `git worktree remove`, which keeps any worktree with uncommitted or untracked files) and turns the sweep in `orq wait` off.

| Scope | Keys |
|---|---|
| project (`.orq/config.json`) | `autonomy`, `base`, `cap`, `checks.setup`, `checks.unit`, `checks.full`, `pollSeconds`, `stallMinutes`, `gateConcurrency`, `leaseTtlMinutes`, `finalTimeoutMinutes`, `questions`, `share`, `goal`, `cleanup` |
| machine (`~/.t3orq/config.json`) | `cap`, `perInstanceLimit`, `usageThreshold` (1-100, default 90: see [Account usage](scheduling.md#account-usage)); `t3Home` is recorded by `sync` |

`checks.unit` runs in every unit's gate after the evidence. `checks.full` runs once on the integration head.

`cap` exists in both scopes. With `--machine` it is the machine-wide cap, as before. Without it, it is this project's own optional limit (a positive integer; `null` removes it): the project's threads (units, reviews, decisions) never exceed it, and the machine cap still applies to all projects together. A value that is not a positive integer is refused (`orq: cap must be a positive integer, got <value>`, exit 1). See [The cap](scheduling.md#the-cap).

`goal` is the project's standing goal, for work larger than one plan. Set it with `orq config set goal "<sentence>"`; `null` clears it (a config file that holds `"goal": null` reads as no goal). The value is cut to one line (whitespace runs, including newlines, become one space) and control characters are removed. It must not be empty and is at most 500 characters (`orq: goal must be at most 500 characters, got <n>`, exit 1). `set` prints the stored value. If `orq plan archive` cannot read the config after archiving, it prints `note: config unreadable: <why>` and still exits 0. While it is set, `orq wait`, `orq plan archive` and `orq status` print it (see below).

## plan check

`orq plan check [--json]`

Prints `plan ok: <n> units, order: <ids>`, or one `error: <problem>` line per problem and exit 4. When three or more units are still to run, the line before `plan ok` says how parallel they are: `shape: <n> units to run, <r> can start now, longest chain <c>`, or, when every one of them waits on another, `warning: the <n> units still to run form one chain, so they run one at a time; keep a dep only where a unit needs what another commits`. `--json` carries the same warnings as the text. Before `plan ok` it prints `warning: <unit>: evidence runs a file outside the repository (<paths>); a check belongs in the repository, written by a unit` for a unit whose evidence names a file under `.orq/`, or an absolute path (`/…`, `~/…`) outside the project that is a command word or ends in a file extension; paths under system locations (`/usr`, `/bin`, `/sbin`, `/opt`, `/nix`, `/snap`, `/dev`, `/proc`, `/sys`, `/etc`, `/System`, `/Library`, `/Applications`) are not counted. A warning never changes the exit code; `orq wait` sums them up once per call in one note: `note: <n> units run evidence outside the repository (<up to 3 ids>[ +<k> more]); run "orq plan check" for the list`. `--json` adds a `warnings` array. A unit may set `"setup": false` (boolean, default `true`) to skip `checks.setup` in its own gate, and `"share": false` (boolean, default `true`) to keep its worktree and gate from linking shared dependency directories; any other value is an error. When the ledger knows units that `plan.json` no longer lists (a new request written over a plan that was not archived), `plan check` and `orq wait` refuse with exit 4: `plan.json no longer lists units the ledger knows (<ids>); this looks like a new request: restore plan.json or run "orq plan archive" first`. Adding units is fine, and so is editing the goal while the plan runs. Once the ledger's plan is finished (every unit integrated or dropped and the final gate has judged the current head), a plan.json with another goal is refused the same way: `plan.json has a new goal ("<new>", was "<old>") but the ledger's plan is finished; this looks like a new request: restore plan.json or run "orq plan archive" first`. Ledgers from before goals were recorded are not checked. `orq plan archive` then archives the ledger without that `plan.json`, leaves `plan.json` and the work orders in place for the next request, and prints `note: plan.json did not match the ledger; archived the ledger and kept plan.json for the next request`. Exit 1 when there is no plan. It checks the schema, job classes, unit ids, dependencies and cycles. It also checks that each work order is a file under `.orq/` of at most 40 lines, and that units which could run in parallel have non-overlapping `paths`.

## plan archive

`orq plan archive`

Each request gets its own plan, ledger and integration branch. This moves the current plan's state (`plan.json`, `ledger.jsonl`, `units/`, `orders/`, `reviews.json`, `summary.md`) into `.orq/archive/<planId>/`, removes the integration worktree when it is clean, and keeps the integration branch. It also runs the [cleanup](how-it-works.md#cleanup) over the worker, review and decision worktrees (every worktree on an `orq/*` branch, including leftovers of earlier plans): uncommitted work is saved under `.orq/salvage/`, then the worktree is removed, and it prints `removed <n> worker worktrees, freed <size>` and one `saved uncommitted work of <branch> to <file>` line per patch. A new file over 256 KiB is named in the patch, not saved, and the line says how many. A worktree it keeps (locked, a thread still holding a lease or at work in T3, work over the salvage cap, a repository or an initialized submodule inside it) gets a `note: kept worktree <path>: <why>` line. An `orq/*` worktree no ledger of this project names is left alone. It asks T3 for the project's threads once; when that fails it falls back to a plain `git worktree remove`. The worktree of a dropped unit is left alone (its thread may still be working there); the sweep of the next `orq wait` removes it once T3 shows the thread stopped. With `cleanup: false` the removal is a plain `git worktree remove`, which keeps a worktree with uncommitted or untracked files. No branch is ever deleted. Config, memory and capabilities stay. The next `plan.json` starts a new plan cut from the configured base.

It refuses, with exit 4, while anything is in flight: a unit that is running, blocked, gating or passed but not merged, a running gate or review, a running `orq wait`, or an integration worktree with uncommitted changes. Units that were never integrated do not block it; it lists them in a note.

```
archived: plan <planId> (<n> integrated, <m> not) -> .orq/archive/<planId>/
integration branch kept: <branch>
```

When a standing goal is set (see [config](#config)), two lines follow the others: `goal: <text>` and `next: the goal is still open: plan its next part now and call "orq wait"; run "orq config set goal null" only when nothing of it is left to build`.

While an archive is in progress the project is frozen: it writes `.orq/archiving.json` first, and every other command that touches plan state refuses until the archive finishes. If it was interrupted, run it again; nothing is deleted until the archived ledger matches the live one. If it can never finish, its error says how to unfreeze: deleting `.orq/archiving.json` keeps whatever plan state is still under `.orq/` in use.

## wait

`orq wait [--max-seconds N]`

This runs the scheduler for up to `N` seconds (default 480). The first line it prints is one of `done:`, `final-fail:`, `judgment:`, `blocked:`, `idle:` or `timeout:`, and in `continuous` mode also `ship-ready:`. It exits 0 for each of them. When the running kit's playbook differs from the one recorded (`orq update` moved the kit, or the project was set up by an older kit), the second line is `playbook: the kit was updated (<old kit12|unknown> -> <new kit12|unknown>); read <path of the running kit's playbook/ORCHESTRATOR.md> again now, then run "orq init"`. When threads orq started are done for good and still unsettled in T3, the next line is `settle: <threadId> <threadId> …` (at most 20 ids, then `+<n> more`); notes and detail lines follow. See [Scheduling](scheduling.md#what-orq-wait-returns). When a standing goal is set (see [config](#config)), the `done:` line is followed by `goal: <text>` and `next: the goal is still open: finish this plan as the playbook says, run "orq plan archive", then plan the next part and call "orq wait" again in this same turn`. Exit 4 when the plan is invalid or uses the reserved unit id `integration`. When there is no plan file and a goal is set, the `no valid plan` error on stderr is followed by `goal: <text>` and `next: the goal is still open: plan its next part, run "orq plan check", then call "orq wait"`; an invalid plan that exists gets the error alone, since its units may be in flight. Exit 1 when no usable `t3` is recorded. Exit 5 when another `orq wait` holds this project, except that a waiting message is delivered first.

Before anything else, when `.orq/inbox.md` (see [inbox](#inbox)) is not empty, `orq wait` moves it to `.orq/inbox-read/<iso time>.md` and returns at once, exit 0, with the first line `message: from the user, through orq inbox; read it and follow it before anything else` followed by the file's lines as written (its `## <iso time>` headers included). It prints at most 60 of them; a longer message ends with `… <n> more lines in .orq/inbox-read/<file>`. Each message is delivered once. This happens with or without a plan, and while an archive is unfinished; while the scheduler runs, a message that arrives is returned on its next poll. Delivery takes the project lock, so two calls never deliver the same message and a message appended meanwhile is never lost. When `.orq/inbox.md` is tracked by git it is not delivered (it may have come in a commit, not from the user): the file stays and `note: .orq/inbox.md is tracked by git, so it may not come from the user; not delivered` is printed once per call (after the error, when the call then fails).

In `continuous` mode two lines are added and `done:` means more:

- `ship-ready: <green12> passed the final checks; <k> units not shipped yet; run "orq ship"` when the latest head that passed the final checks is not shipped yet; `k` counts the units integrated since the last ship up to that head. It comes after `judgment:` and `blocked:` lines and before anything else. When origin's base, as `orq ship` last fetched it, has moved past that head, `orq ship` would refuse it: `orq wait` prints no `ship-ready:` line for it and keeps working, with a note that says so, and when nothing else is open it prints `ship-blocked: <green12> passed the final checks, but origin/<base> moved past it; append a unit with job "fix" that merges origin/<base> into the integration branch`.
- `final-fail: <head12> fails the final checks while units are still open; <failures>; details in .orq/units/integration/head-<head12>.json` once per failing head while units are still open. Printing it records a `final-noted` event, so the same head is not reported again; a later final run on a newer head may report again. A `final-fail:` once every unit is in reads as in the other modes.
- `done:` only when every unit is integrated or dropped and the integration head is shipped (or nothing was integrated).

## inbox

`orq inbox <text> | orq inbox - < text`

Appends a message for the orchestrator to `.orq/inbox.md`, under the project lock, and adds `.orq/` to git's exclude file as `orq init` does: a header line `## <iso time>`, then the text (the arguments joined by spaces, or stdin with `-`). It prints `inbox: queued for the next "orq wait"` and exits 0; empty text is exit 2. A message sent to the orchestrator's thread waits until its turn ends, which can be hours; `orq wait` returns at least every 8 minutes, so its next call delivers the message (see [wait](#wait)). `orq status` prints `inbox: <n> message(s) waiting` while it is not empty. `orq plan archive` leaves `.orq/inbox.md` and `.orq/inbox-read/` in place.

## status

`orq status [--json]`

```
plan: <goal> (<planId>|not started)
goal: <text>   (only when a standing goal is set)
playbook: the kit was updated (…); read <file> again now, then run "orq init"   (only after a kit update)
inbox: <n> message(s) waiting   (only while .orq/inbox.md is not empty)
integration: <branch> head=<sha> base=<sha>
ship: green=<sha12|none> shipped=<sha12|none> ships=<n>   (continuous mode only)
cap=<n> active=<n> blocked=<n> gates=<n> machine_leases=<n>[ expired_leases=<n>][ project_cap=<n> project_leases=<n>]
providers: … (as for init)
usage: <instance> <used>% <window>[ resets <iso time>]|down|stale|unreadable; …   or   usage: no T3 provider cache in <dir>
worktrees: <n> on orq branches[; <k> salvage patches in .orq/salvage/ (kept 30 days; past 7 days, at most 100)]   (only when there are any)
<unit> <state>[ attempt=<n>][ model=<key>][ tier=<n>][ wanted_tier=<n>][ continued][ rerouted=<from>-><to>(<reason>)][ thread=<id>][ flags=<kinds>][ <reason>]
authors: max_tier=<n> family=<family>
cooling: <instance> until <iso time>, …
note: cap covers threads orq started; threads started by hand are not counted
```

When the machine `cap` is an override above what the machine computes, a line `note: cap <n> is an override; this machine computes <m> (<reasons>)` comes before the last note; `orq wait` prints the same note once per call. When the project sets its own `cap`, the cap line ends with `project_cap=<n> project_leases=<n>` (this project's live leases), and when that cap leaves fewer free slots than the machine cap does, a line `note: project cap <n> is the limit in force: <k> slots free for this project, <m> under the machine cap <c>` comes before the last note. `--json` has `projectCap` (null when unset) and `projectLeases`. The `goal:` line is the standing goal from the project config; the `plan:` line and `--json` `plan.goal` are the running plan's own goal. A line `ask: decision <n> running thread=<id> model=<key>` follows the `authors:` line for each decision thread still running, then `abandoned: thread <id> of unit <u> holds a slot until it ends` for each thread `orq` gave up on whose lease still counts against the cap. The `usage:` line shows [account usage](scheduling.md#account-usage) as T3 reports it, also between plans: per instance its fullest window, `down` (T3 reports it in error or signed out), `stale` (the reading is over an hour old) or `unreadable`; instances with nothing to report are left out, and the line too when none has anything. When no instance has a T3 cache file it reads `usage: no T3 provider cache in <dir>`, naming the directory searched. `--json` has the reported instances as `usage` (absent when none). The `integration:`, `authors:`, `ask:` and `cooling:` lines appear only when they apply. `wanted_tier` appears when the unit was launched below its minimum tier because no model at that tier was usable. `rerouted` appears when the unit's current launch followed a provider failure on another model: the model it left, the one it runs on, and why (`limit`, `auth` or `capacity` for a [limit failure](scheduling.md#failure-ladders), else how the thread ended). The `worktrees:` line counts the worktrees on `orq/*` branches other than the integration worktree, and the patches the [cleanup](how-it-works.md#cleanup) saved; it shows no size, since summing it reads every file. It is printed between plans too.

## unit

`orq unit retry <id> [--tier N] | orq unit drop <id>`

`retry` moves a `failed` unit back to `queued` and clears its attempts, its excluded models and its provider failure count. `--tier` sets a minimum tier (1-4). It prints `retried <id>: queued[, minimum tier <n>]`, with `, continues from the work left by <key>` when the unit was judged for provider reasons and no `--tier` is given (the next worker then continues that work). A unit that failed because `checks.setup` failed goes back to `gating` instead, to gate its branch again; it prints `retried <id>: its branch will be gated again`. `--tier` is refused for such a unit (exit 1), since no new worker runs. A unit that failed with `gate could not complete` is gated again the same way and prints the same line, unless `--tier` is given: then it is queued for a new worker. `orq unit retry integration` runs the final gate again when it could not complete, when its setup failed, or when its checks failed (`final-fail:`); it uses the current `checks.full`. In `continuous` mode it looks at the head the last final run started on, and counts that head's starts only.

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

The decision thread routes job `decide`: tier 4, strongest first. When no tier-4 model exists, or all are cooling down or at their limit, the strongest free model decides instead (its key and tier are recorded and shown in the summary); `no model` means nothing at all is routable. When a decision thread fails, or does not start, the next `decide` candidate is tried (the failed models are excluded and their instances avoided), at most 3 threads per ask within `--max-seconds`; each try is a record in `.orq/asks.json`. Only then does it print `escalate: no decision (<last reason>; tried <key>, …)`. It holds a machine lease while it runs. When every slot is held it waits for one within `--max-seconds`, then prints `escalate: no decision (no free machine slot)`. Its first message is `playbook/templates/decision-order.md`, then `## Question (data)`, `## Plan (data)` (goal and decisions, when a plan exists) and, with `--unit`, `## Unit (data)` (id, title, paths and the work order; an unknown id is exit 2). Each section's text is inside a code fence longer than any backtick run in it, so a heading or a rule inside a question cannot change the order's rules. It runs on the integration head on branch `orq/<planId>/ask-<n>` once the plan has started, else on the configured base on branch `orq/ask-<n>-<time>`. The decision's number and branch are reserved in `.orq/asks.json` (status `starting`, with `branch`) before the thread starts, so concurrent asks never share a branch or a lease, and the [cleanup](how-it-works.md#cleanup) removes its worktree by that exact branch. `.orq/asks.json` records each decision (`starting`, `running`, `answered`, `escalated` or `failed`, with the model's key and tier), and `orq plan archive` moves it with the plan; a decision still running then gets a `note: decision <n> is still running in thread <id>; its outcome will not be recorded` line.

`--show` looks at decision `n` (default: the latest) once and prints the same lines; it records an outcome only once. A decision still `starting` prints `pending:` until its asker's deadline, then `escalate: no decision (decision <n> never started)`. A decision that is not in `.orq/asks.json` (for example archived) prints `escalate: no decision (decision <n> is not in this plan)`. Exit 3 inside a worker thread, as for `init`.

## settle

`orq settle [--all]`

Lists the threads `orq` started that are done for good and that T3 reports as not settled, one per line: `<threadId> unit <id> integrated|dropped|replaced`, `<threadId> review <n>` or `<threadId> decision <n>`. It prints `nothing to settle` when there are none, and exits 0. `--all` also covers the archived plans under `.orq/archive/`. T3 has no CLI command to settle a thread: the orchestrator settles each listed id with its `t3_thread_organize` tool (`action: "settle"`). It calls `t3 thread list` once, outside any lock. `orq plan archive` prints `settle: run "orq settle --all"` when archived plans leave such threads.

## worktree prune

`orq worktree prune [--force] [--dry-run]`

Removes the worker worktrees of every integrated unit of the running plan: the same removal `orq wait` starts when a unit is integrated, done one worktree at a time and waited for. Use it for units an older `orq` integrated (before 0.3.0 nothing was removed until `orq plan archive`), or when a removal at integration did not happen. It runs a plain `git worktree remove`, with no time limit: a worktree with uncommitted or untracked files, or a locked one, is kept and reported in a `note: kept worktree <path>: <git's message>` line, files git ignores go with the worktree, and no branch is deleted. It picks worktrees by branch: every worktree checked out on a launch branch of an integrated unit, wherever it is. Worktrees of units that are not integrated, of a thread that still holds a lease, the integration worktree and gate checkouts are not touched. It prints `removed <n> worktrees of integrated units`, or `nothing to prune`, and exits 0. `--dry-run` prints one `would remove <path>` line per worktree and removes nothing. It takes no lock; a worktree that `orq wait` is removing at the same moment may be reported as kept, and is gone on the next run. Exit 3 inside a worker thread, as for `init`; exit 4 while an archive is unfinished.

`--force` runs the [cleanup](how-it-works.md#cleanup) that `orq wait` runs, on everything it covers, including the worktrees of earlier, archived plans and gate leftovers, and waits for it. It asks T3 for the project's threads once; when that fails it removes nothing by force (a plain `git worktree remove`, which keeps a dirty worktree, and a dropped unit's worktree stays). It prints `removed <n> worker worktrees[ and <g> gate checkouts], freed <size>`, one `saved uncommitted work of <branch> to .orq/salvage/<file>` line per patch and one `note: kept worktree <path>: <why>` line per worktree it kept, or `nothing to clean`, and exits 0. With `--dry-run` it prints `would remove <path>` per worktree and gate directory, and `would keep <path>: <why>` for one the run would keep for want of a safe patch, and changes nothing. One run starts no new removal once it has none left; `note: <n> more to remove; run it again` only appears after a sweep inside `orq wait` hit its time budget. When another cleanup holds `.orq/cleanup.lock` it prints `note: another cleanup is running; it removes what is left`.

## ship

`orq ship`

Continuous mode only; in any other mode it refuses with exit 4: `ship: runs only in continuous mode (autonomy is <mode>); "orq config set autonomy continuous" turns it on`. It ships the latest integration head that passed the final checks (`green`) when it differs from the last shipped head, and prints `nothing to ship: …; run "orq wait"` (exit 0) otherwise. The base branch is the config `base` without a leading `origin/`; the remote is `origin`.

1. `git fetch origin <base>`. Unless `origin/<base>` is an ancestor of the head, it refuses with exit 4: `ship: <base> moved on origin; append a fix unit that merges origin/<base> into the integration branch`.
2. It pushes the head to `orq/<planId>/ship-<n>` (`n` counts the ships of this plan; see below) and opens a pull request against the base with `gh pr create`. Title: `<planId> ship <n>: <up to 3 unit ids>[ +<k> more]`, the units first integrated in this ship; the body lists them with their titles, says `final checks passed on <sha>` and names the `checks.full` command. An open pull request on that branch and head, left by an interrupted ship, is reused.
3. It fast-forwards the base on `origin` with a plain push of the head (never forced: git refuses a non-fast-forward). The host marks the pull request merged once its head is in the base; `orq ship` polls `gh pr view` for up to 30 seconds. It never merges the pull request itself, so no merge commit lands on the base; when the host has not marked it merged by then, the ship is recorded anyway and a line `note: <pr url> is not marked merged yet; GitHub marks it once it sees the push, nothing to do` follows.
4. It records a `shipped` event and prints `shipped <sha12> as <pr url>: <k> units`.

The base moves by a direct fast-forward push, so the host's checks on the pull request do not run before it does: `checks.full` is the gate. Only a head whose final run passed ships: a head with any other verdict is refused with exit 4 (`ship: <sha12> has no passing final checks (verdict <v>); set checks.full …`). `orq config set autonomy continuous` is refused while `checks.full` is not set, and `checks.full` cannot be cleared while the mode is `continuous`. The pull request body names the `checks.full` command that run used. The ship branch is the first `orq/<planId>/ship-<n>` from the next number on that is free on `origin` or already holds the head; a pull request is reused only when it is open and its head is the head being shipped. `orq ship` holds the runner lock (the one `orq wait` and `orq plan archive` hold), so it refuses with exit 5 while either runs or another ship does, and a head that is not later in the integration order than the head shipped before is refused with exit 4 before anything is pushed (the order comes from every `integrated` event in the ledger, so a plan switched to `continuous` midway works).

Every failure prints one line naming the step that failed and the way out, with exit 1: a failed fetch or branch push ships nothing; a failed `gh pr create` names the pushed branch; a failed base push names the open pull request (running `orq ship` again reuses it). git and `gh` run outside every lock.

## summary

`orq summary [--out <file>]`

Writes the pull request body to `.orq/summary.md`, or to another `.md` file directly under `.orq/`. The body has these sections: goal, decisions, decisions taken without you (answered `orq ask` decisions: question → answer and the model; omitted when there are none), a unit table, evidence results, final checks, reviews, and units not done. It prints `summary: <file> (<n> lines)`. Exit 4 when the plan has not started.

`orq summary --plan <planId>` prints the summary of an archived plan and writes nothing.

## stats

`orq stats [--all] [--json]`

Counts, per model, how the runs went, read from the ledger. Events count for the model the unit was last launched on. Columns: `launched`; `done` (thread ended completed); `prov-fail` (thread ended any other way, a failed start included); `gate-pass` and `gate-fail`; `first-pass` (the unit's first gate result was a pass or no-evidence on attempt 1, on a launch that did not continue another worker's commits); `no-commit` (a gate failure because the worker committed nothing, or a turn that ended empty and was told to go on); `stopped` (the worker reported `BLOCKED` or `NEEDS_CONTEXT`, counted for each report: the first one, told to go on, and a later one that went to judgment); a unit told to go on either way has no first pass; `continued` (launches that took over the commits of a worker whose provider failed). The `--json` object also has `integrated` per model. Above the table: plans, units, integrated, dropped and failed units, wall-clock minutes (first to last event per plan, summed), worker minutes (launch or feedback to thread end), launches per tier and per instance. Rows are most-launched first, at most 40. `--all` adds every archived plan of this project. Prints `no runs recorded` when the ledger is empty.

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
running orchestrators are told on their next "orq wait"
```

With `--check` it changes nothing, works even when the kit has local changes, and prints `update available: <old> -> <new>[ (<tag>)]` or `would move (not a fast-forward): <old> -> <new>`. Either way, it prints `up to date at <sha>` when there is nothing to do.
