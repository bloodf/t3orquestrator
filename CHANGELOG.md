# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.3.1] - 2026-11-14

### Added

- `orq worktree prune [--dry-run]` removes the worker worktrees of units that are already integrated in the running plan. Since 0.3.0 that happens at integration; this covers units an older `orq` integrated, and a removal that did not happen. Same limits: a plain `git worktree remove`, so a worktree with uncommitted or untracked files is kept, and no branch is deleted.

### Fixed

- The removal of an integrated unit's worktrees (0.3.0) let git decide what is untracked from the repository's own config. With `status.showUntrackedFiles=no` set there, by the user or by a worker, a worktree holding untracked files was removed with them. Untracked files now always count, as they already did at `orq plan archive`.

## [0.3.0] - 2026-11-14

### Added

- A worker whose turn ends with nothing committed is told to continue in the same thread, once per thread, before anything counts as a gate failure. In two real runs one gate in four failed only for this reason, and almost every such worker committed on its next turn. The ledger records it as `unfinished`; `orq stats` counts it under `no-commit`.
- `orq plan check` says how parallel the units still to run are, and warns when they form a single chain.
- The worktrees of a unit's threads are removed as soon as the unit is integrated, instead of at `orq plan archive`. Branches are kept, and a worktree with uncommitted or untracked files is never removed. In one real run 162 worktrees (13 GB) had piled up inside a single plan.
- `orq init` says when a pnpm or bun project has no `node_modules` in its root (`share: none (node_modules is not installed in the project root: …)`), and detects sharing again on the next `orq init` once it is installed. An empty `share` list is no longer kept as if it were a choice; `share null` still turns sharing off.

### Changed

- `orq unit retry <unit>` after `gate could not complete` gates the same commit again instead of starting a new worker. `--tier N` still starts a new worker.
- The message for a turn that ended without a commit now also names the way out when nothing needs to change (`BLOCKED` with the reason).
- The work order template tells the worker to finish in one turn.

### Fixed

- A gate no longer fails with `workDir exists and is not a worktree` when a step started by a killed gate still writes into `.orq/gate/<unit>`: it runs in a directory beside it.

## [0.2.0] - 2026-11-13

### Added

- A unit continues after a provider failure: the next worker starts from the commits the failed one left, with a hand-over note, and the gate judges all of it. A failed decision thread is retried on up to two other models, and a failed review is replaced on another model.
- A thread T3 keeps as running but that stays quiet for twice `stallMinutes` is given up and the unit continues on another model.
- `settle:` lines in `orq wait` and the command `orq settle [--all]` name the threads that are finished for good, so the orchestrator can settle them in T3.
- Plan field `setup: false` on a unit skips `checks.setup` in that unit's gate.
- `orq plan check` warns when a unit's evidence runs a file outside the repository or under `.orq/`.
- A `note:` in `orq status` and `orq wait` when the `cap` override is above what the machine computes.
- Worker, review and decision worktrees link `node_modules` from the main checkout in pnpm and bun projects (config key `share`, unit field `share: false`). npm and yarn projects are never linked: `npm ci` was tested to empty a linked directory.
- A `providers:` line in `orq init`, `orq sync` and `orq status`: usable, disabled in T3, disabled by you, cooling.
- Routing prefers, within a tier, models with a better first-pass record for the job class, and tries a model that keeps failing a class last.
- A `playbook:` line in `orq wait` and `orq status` when the kit changed since the orchestrator read the playbook, so running orchestrators update themselves.
- `orq plan check` and `orq wait` refuse a `plan.json` that dropped units the ledger knows; `orq plan archive` handles that case.
- `orq stats [--all] [--json]`: per-model launches, provider failures, gate results, first passes and stops from the ledger, plus tier, instance and time totals.

### Changed

- A thread status from T3 that this version does not know is treated as running, with a note, instead of failing every poll.
- Playbook: before planning, the orchestrator asks once, at most five questions that change what gets built, each with the answer it will assume.
- Playbook: the orchestrator writes no record files of its own, a replacement orchestrator resumes with `orq wait`, and evidence must run what is in the repository.
- Work orders state that the worker implements directly and that standing coordinator rules (delegate, wait for approval, hold) do not apply to it; a missing code search tool is never a reason to stop; the status word is one of the four, in English.
- Playbook: pick the lowest job class that can do the work, with reading and surveying in the cheapest class; the orchestrator leaves `cap`, `perInstanceLimit` and `pollSeconds` alone.
- Feedback after an attempt that committed nothing tells the worker to do the work itself and commit.
- `pollSeconds` has a floor of 5.

### Fixed

- A gate directory left by a killed gate no longer ends the unit with `gate could not complete`.

## [0.1.2] - 2026-11-13

### Added

- `orq ask`: a worker's question, or a product decision the request does not settle, is answered by the strongest enabled model instead of waiting for the user. On by default (`questions=auto`); `orq config set questions user` turns it off. What that model must not decide (destructive actions, spending, anything beyond the autonomy mode) is asked of the user in the orchestrator's thread, never in a worker's.
- `orq summary` lists the decisions taken without the user.
- Routing job `decide`, which picks the strongest available model first.

### Changed

- `orq review show` prints the reviewer's report indented and bounded, so a report cannot be read as an `orq` result line.

## [0.1.1] - 2026-11-13

### Changed

- `orq wait` returns `final-fail:` when the final checks fail. `done:` now always means the checks passed or none were configured.
- A provider failure no longer excludes the model for that unit. Other models are tried first; a lone model is retried after its cooldown, up to three provider failures.
- A `checks.setup` step is retried once. If it still fails the unit goes to the orchestrator as `setup failed` and is not sent back to the worker; `orq unit retry` gates the same commit again.
- `orq unit drop` refuses a unit that others depend on, and a queued unit whose dependency was dropped goes to the orchestrator.
- The paste stub runs `orq init` in the project root and says what to do when the kit or Node is unavailable.
- Playbook: one row per `judgment:` reason, separate rows for the `idle:` forms, a bound on fix units after a failed final check, tiers of unknown models are settled once, and an open accepted finding blocks an automatic merge.

### Fixed

- The gate kills a step's process group when the step succeeds too, so a step cannot leave a background process running.
- Replies from `t3` larger than 1 MiB no longer fail the poll.
- A symlinked work order is rejected by `orq plan check`.
- `note:` lines can no longer push a decision line out of the `orq wait` output.
- `orq unit retry integration` runs the final checks again after a `final-fail`, so narrowing `checks.full` can finish a run.
- A full machine cap no longer hides a unit that no model can take.
- A unit held back only by a provider instance's concurrency limit waits for a slot; it used to end the wait as `idle`.
- When other projects hold every machine slot, `orq wait` keeps waiting for one. It used to return `idle` at once, sometimes with the wrong reason, so an orchestrator calling it again would spin.

### Added

- A `note:` and `wanted_tier=` in `orq status` when a unit runs on a lower tier than its job asked for.
- `orq plan archive` removes worker and review worktrees (`orq/*` branches) with plain `git worktree remove`; worktrees with uncommitted or untracked files are kept and reported, and no branch is deleted.

## [0.1.0] - 2026-11-13

### Added

- Repository foundation: license, contributing guide, code of conduct, security policy, issue and pull request templates, CI workflow.
- `orq` CLI entry with a command table and the `help`, `--version` and `probe` commands.
- Machine probe that computes how many agent threads may be active, with a config override.
- Path helpers and state-file utilities: durable atomic JSON writes, JSON-lines append and read that tolerate and repair a torn tail, `appendLine` that is safe without a caller-held lock, and a file lock (`lib/lock.mjs`) based on owner liveness with a guarded takeover.
- `probe` reports the reason for each bound and note, rejects unknown options, and honours a validated `cap` override that still respects instance limits.
- T3 Code adapter (`lib/t3.mjs`): the only module that talks to the `t3` CLI, with output validation that detects drift in its JSON.
- Capability registry: merges what T3 reports, harvests proven instance and model pairs from thread history, tracks failures with exponential backoff, and never overwrites tiers set by the user or the orchestrator.
- Job routing by class and tier (`playbook/routing.json`), with a different-family preference for review and explicit results when nothing is routable.
- Dated, optional suggestion files for model tiers (`playbook/suggestions.json`) and tools (`playbook/tools.json`).
- Capability slots (judge, memory, code index, git host) resolved from a catalog, each ending in a built-in path that needs nothing installed.
- Commands `init`, `sync`, `route`, `model add`, `tier set`, `config get|set` and `plan check`.
- Plan validation: schema, dependency cycles, work orders confined to `.orq/`, and path overlap between units that could run in parallel.
- Quality gate (`lib/gate.mjs`): judges exactly the committed bytes between two full commit SHAs, checks changed files against a unit's writable and forbidden paths, and runs setup, evidence and scoped checks in a fresh detached worktree with hooks and fsmonitor disabled.
- Diff scan that flags skipped or focused tests, placeholders, deleted or weakened test files, and changes to a file the evidence command names. Flags never fail the gate on their own.
- Integration merge (`lib/integrate.mjs`): merges gated commits one at a time into an integration worktree, skips what is already merged, and aborts cleanly on the first conflict.
- Scheduler: `orq wait` launches ready units as slots free, counts only active threads against a machine-wide cap, gates finished units in detached processes, merges passed units into an integration branch, and returns to the orchestrator only for `done`, `judgment`, `blocked`, `idle` or `timeout`.
- Unit ledger as an explicit state machine over an append-only event log; leases as the machine-wide, heartbeated record of running threads, also used to recover a launch interrupted by a crash.
- Failure ladder: a failed gate first goes back to the same thread, then to a fresh thread one tier up with the failed model excluded, then to the orchestrator. Provider failures relaunch on another model.
- Plans can grow after they finish; final checks are tied to an integration head and re-run when it moves.
- Commands `wait`, `status`, `unit retry|drop`, `review start|show` and `summary`.
- Playbook: the paste stub (`BOOTSTRAP.md`), the orchestrator's operating loop (`playbook/ORCHESTRATOR.md`), work-order and review-order templates, and an example plan, with tests that enforce their size budgets and that they name only real commands.
- Rerouting away from a failing provider instance: a unit avoids any instance that already failed for it, two failures in a row cool the whole instance down for every project, a completed thread marks its instance alive again, and `orq status` lists the instances that are cooling.
- `orq plan archive`: each request gets its own plan, ledger and integration branch. The archive is crash-safe: the project is frozen while it runs and nothing is deleted until the archived ledger matches the live one.
- Gate feedback carries the failing step's output. A worker whose report starts with `BLOCKED` or `NEEDS_CONTEXT` goes to the orchestrator without a gate, and the same commit is never gated twice for one unit.
- `orq version` and `orq update [--to <tag|sha>] [--check]`: move an installed kit to the latest tagged release without moving backwards unless told to; `orq init` prints the kit commit.
- Documentation: how it works, scheduling, command reference, provider terms, and a worked example profile.
- `evidence-target-changed` is no longer raised for a test file the unit added itself.
- `orq instance list|disable|enable`: a local switch that keeps automated threads off a provider instance T3 reports as available. `sync` never overwrites it.
- CI pins `actions/checkout` and `actions/setup-node` by commit SHA and runs on pushes to `main` and on pull requests.
- A gate that dies without a result reports the last line it logged, for unit gates and the final gate. The log of an earlier gate run is never read as the reason.
