# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.11.0] - 2026-11-17

### Added

- Thread titles say what a thread is for: `<Type> - <Ticket> | <Name>`, at most 100 characters, cut on a word. A unit's type comes from its job (`Implement`, `Fix`, `Test`, `Docs`, `Chore` for `mechanical`, `Explore`, `Summary`, `Plan` for `plan` and `architecture`, `Debug`, `Review`, `Decision`), its ticket from the `#<n>` refs its title starts with (at most 3, then `+<n>`; else the unit id), its name from the rest of the title. A review is `Review - <the integrated units' refs, or the plan id> | <the plan's goal, or Integration review <n>>`, a decision `Decision - ask-<n> | <the question's first line>`. Before: `orq <unit>: <title>`, `orq review <n>`, `orq ask <n>`. Nothing in orq reads thread titles.
- Machine routing policy (`orq config set --machine <key> <value>`; see [Machine routing policy](docs/scheduling.md#machine-routing-policy)): `freeModels` (default `[":free$"]`) are routed first among eligible candidates, except for `decide`, and `orq route` marks them `free`; `excludeModels` (default `["^ollama-local/"]`) are never routed; `decisionOnly` (default: `astra` or `fable` as a part of the model id) are routed only for `decide`, so a top model no longer implements, fixes, tests, documents or reviews, and a job left with only such models waits, saying so; `instanceFamilies` (default: any instance whose id contains `antigravity` runs only `google` models) limits the families an instance may run. A pattern with a comma needs the JSON list form. A thread already running on a decision-only model when you upgrade keeps its feedback rounds in that thread; its unit's next launch goes elsewhere. The `providers:` line of `orq status` and `orq sync` ends with the free and excluded models and the family limits.

### Changed

- Every relaunch of a unit goes to a model none of its launches used, of another family first, whatever ended the launch before it, `orq unit retry` included; a used model is launched again only when no unused one is eligible, with a note. Each unit records the models it was launched on (`used`); `orq status` shows them as `used=<key>,…`.

## [0.10.1] - 2026-11-17

### Added

- Gate steps learn what the unit changed, so `checks.unit` can run only the related tests while the final gate keeps running `checks.full` whole. Every step gets `ORQ_GATE` (`unit` or `final`); a unit's gate steps also get `ORQ_BASE_SHA` (the commit the unit's work is judged against), `ORQ_UNIT_JOB`, and `ORQ_CHANGED_FILES` and `ORQ_DELETED_FILES`, absolute paths to lists of the repository-relative paths the unit added, copied, modified or renamed (new path), and deleted (including a rename's old path); the lists are removed when the gate ends. For a `fix` unit, when the diff cannot be computed, or when a path contains a newline, the lists are not set, and a command should then run everything. orq's own gate variables are never inherited from the environment it runs in. orq stays project-agnostic: the command decides what to run. See [config](docs/commands.md#config) for a `vitest related` example.

## [0.10.0] - 2026-11-17

### Changed

- In `continuous` mode, `orq wait` keeps the integration branch merged with origin's base. When another machine ships often, a head that passed the final checks was always behind origin by the time it could ship, and the `fix` unit that merged the base took hours (in one project 4 passed heads shipped 0 times, and the green head ended 42 commits behind). Now, while there are unshipped units, `orq wait` fetches origin's base (at most every 5 minutes across calls, recorded in `.orq/sync.json`; the fetch gives up after 60 s) and, when the integration head lacks commits from it, merges that fetched commit into the integration branch itself: a plain merge commit in the integration worktree, under the runner lock, recorded as a `synced` event (`from`, `to`, `base`). The merged head contains origin's base, so its final checks run on it and `orq ship` fast-forwards the base to it; until that head has its final verdict, origin is not merged again. A merge that conflicts is aborted, recorded as `sync-conflicted` (`base`, `files`) and not tried again until origin moves; only then does `ship-blocked:` ask for a `fix` unit, and it names the conflicting files. `orq status` shows `synced=<base12>-><head12>` and `sync-conflict=<base12> in <files>`. `orq ship` itself still refuses a head origin's base moved past. A ledger with `synced` or `sync-conflicted` events cannot be read by an older orq: do not downgrade a project that has them.
- A unit gate whose checks fail only tests that already fail on the integration head it forked from no longer fails. When the final run on that head failed, the failing-test lines of both runs are compared (bun `(fail)`, node:test `not ok` and `✖`, jest `●`, vitest `FAIL <file> > <test>`, `✕`, `×`, pytest `FAILED`, tsc `error TS`; durations, colours and gate checkout paths ignored), each named by its file where the runner prints one (bun's `<file>:` headers, jest's `FAIL <file>`): a unit whose failing tests are all among the head's, whose every other line that reads as an error, failure, warning, unmet threshold or lint diagnostic the head printed too, and whose runner count of failures (bun, node:test, TAP, jest, pytest) is no higher than the head's, passes with a `pre-existing-failures` flag naming them. Anything else fails as before: a failure of its own, a jest file with no test named, an output format none of these match, a missing final result for that head, a timeout, an evidence failure, or a unit with job `fix`. The unit's whole output is read for this (and removed after), and the head's kept log, result tail, and the `baseline` (failing tests, error lines, count; up to 1000 of each) a failed final run now stores in `head-<sha12>.json`, so a unit still has its base's failures after that log is removed by a later pass; never another head's. Only lines actually seen are excused. The flag says that checks after the failing step did not run on the unit. Limit: a test that fails on both for a different reason passes when its error lines read the same. In one project 42 of 66 unit gates failed on the same 10 migration tests that no unit touched.
- `orq ship` takes `--title <text>` and `--body-file <path>`: the orchestrator writes a conventional-commit title and a short summary. orq adds a line for each issue the shipped units' titles start with (`#<n>` refs before the first word): `Closes #<n>` once every unit of the plan naming it is in the head being shipped, `Refs #<n>` before; then `Final checks passed on <sha12>.`; the `checks.full` command stays in the ledger. `--body-file` is read relative to the project. Without `--title` the title is the first unit's title without its issue refs, plus ` and <k> more`. Plan, ship and unit ids now appear only in the branch name (before: `<plan> ship <n>: <unit ids> +<k> more`). A title over 72 characters (after trimming) or on several lines, or a title (given or made from the unit titles) or body that credits a tool or model for the change (🤖, `generated with`/`by`, `written`/`prepared`/`authored`/`orchestrated`/`reviewed` `with`/`by`, a `Co-Authored-By:` or `Assisted-by:` naming one, `built`/`made` `using`/`with Claude Code`, `<model> responding on behalf of`), is refused with exit 2 and nothing is shipped; naming a product (`Add Gemini provider`) is fine. `ship-ready:` now says `run "orq ship --title <conventional title> --body-file <summary file>"`.

## [0.9.2] - 2026-11-17

### Added

- Limit failures. When a thread's provider stops it at a quota or rate limit, a sign-out, or a lack of capacity, and writes that as the thread's last reply (as antigravity, claude and codex do), `orq wait` recognises the text, cools what it names until the reset time the text gives (the instance's models of that family for a limit, the instance for a sign-out, the model for capacity), and relaunches the unit at once on another instance, preferring another model family, continuing the commits the limited worker left. A limit failure costs no attempt, records no failure strike, and does not count toward `3 provider failures`: when every candidate is cooling the unit waits for the earliest reset (`idle: … retry at <time>`) instead of being judged. A turn that completed with a limit reply is not gated. A running thread that went quiet for 5 minutes while T3 shows its account used up (100%) or signed out is given up as a limit failure. Only a short reply whose first line is a provider's error phrasing counts, so worker reports and reviews that mention a rate limit or a login do not. Review and decision threads stopped by a limit cool the same way and are replaced on another model. See [Failure ladders](docs/scheduling.md#failure-ladders).
- A `rerouted` ledger event (`from`, `to`, `reason`, `detail`) for every launch that follows a provider failure on another model, a `note: unit <id> rerouted from <key> to <key> (<kind>: <provider text>)` from `orq wait` after a limit, and `rerouted=<from>-><to>(<reason>)` in `orq status`.

### Changed

- After a provider failure, routing prefers another model family as well as another instance (a failed model, then a failed instance, then a failed family go last).
- Limit failures are counted apart: after 10 the unit goes to judgment (`10 limit failures`), and a second sign-out goes to judgment at once naming the instance to sign in to. A failed thread's narration (`429 tests pass`, `Rate limited the retry loop`) is no longer read as a limit: a bare code or word needs error context. Claude's `5-hour`/`Weekly limit reached ∙ resets …`, `Claude usage limit reached …`, `Claude AI usage limit reached|<epoch>` and Gemini's `RESOURCE_EXHAUSTED` and `OAuth token has expired` are recognised; compact durations (`1h30m`) and daylight-saving changes are read right. A gate pass no longer lifts a limit cooldown; a give-up on T3's usage is not written to the registry; review and decision start failures are classified too, and a review replaced after a limit does not use up its replacements.

## [0.9.1] - 2026-11-17

### Changed

- `orq` now removes the worktrees of finished work even when they hold files, so disk use stays low (on one machine, 110 worktrees of one project held 8.9 GB). `orq wait` sweeps in the poll where a unit is integrated or dropped or a head ships, and otherwise at most every 10 minutes, starting no new removal after 60 seconds per poll; `orq plan archive` runs the same cleanup. It covers every worktree on an `orq/*` branch this project's ledgers, reviews or decisions name, of an integrated or dropped unit, a finished review or decision, or an archived plan (an `orq/*` branch no ledger names, such as another orq project in a linked worktree, is never touched; `orq ask` now records each decision's branch in `.orq/asks.json` for this), plus gate checkouts no gate uses and registrations of missing worktrees. Uncommitted changes to tracked files and new files git does not ignore are first saved as a patch under `.orq/salvage/` (new files over 256 KiB are named, not saved; a worktree whose patch would pass 2 MiB, or that holds a repository of its own or any initialized submodule, is kept and reported; patches are kept 30 days, and past 7 days at most 100), then the worktree is removed with `--force`. Never removed: a branch, the integration worktree, an open unit's worktree, one whose thread holds a lease or where T3 shows a thread at work, a dropped unit's until T3 shows its thread stopped, a locked one. Before, any worktree with an untracked or modified file was kept forever. `orq config set cleanup false` restores the old behavior. See [Cleanup](docs/how-it-works.md#cleanup).

### Added

- `orq worktree prune --force` runs that cleanup on demand, over earlier archived plans too, and prints the space freed (`removed <n> worker worktrees, freed <size>`) and each patch it saved. `orq status` prints `worktrees: <n> on orq branches` and the number of salvage patches.

## [0.9.0] - 2026-11-16

### Added

- Routing reads each instance's usage limits from T3's provider status cache (`<T3 home>/caches/<instance>.json`, written by T3's own usage probe; `orq sync` records the T3 home as `t3Home` for commands run outside T3). A model at 90% or more of a usage window that binds it (`usageThreshold` in the machine config) is skipped until the latest such window resets, instead of failing threads first; an instance T3 reports in error or signed out is skipped too, and readings over an hour old are ignored. Among the rest, models with more headroom go first. `orq status` and `orq sync` print a `usage:` line per instance, and `orq route` a `headroom=` field. Nothing to configure; without T3 usage data, routing is unchanged. See [Account usage](docs/scheduling.md#account-usage).

## [0.8.7] - 2026-11-16

### Fixed

- In `continuous` mode, after `orq ship` refused a passed head because origin's base had moved, `orq wait` returned `ship-ready:` for that same head at once on every call, so it no longer waited. In a real project the orchestrator fell back to polling in the background, ended its turn and sat idle for over 30 minutes. `orq wait` now checks the base as `orq ship` last fetched it: for a head the base moved past it prints no `ship-ready:`, keeps working and adds a note, and with nothing else open it returns `ship-blocked:`, which names the merge unit to append.

## [0.8.6] - 2026-11-16

### Changed

- Units with `job: "fix"` now take free launch, feedback and gate slots before other ready units. Before, they waited in plan order, and a fix appended at the end of a long plan waited behind earlier units. In a real project, a fix for a failed final check waited 10 minutes for a gate slot. A final run then started on a head without the fix and failed again, costing one 23-minute run.

## [0.8.5] - 2026-11-16

### Changed

- A unit whose merge into the integration branch conflicts now goes back to its own worker, on the same attempt, with the integration head to merge and resolve. Before, it went to the orchestrator, whose retry started a fresh worker from scratch: in a real project a large unit passed, conflicted, and was redone twice at about an hour each. After two conflicts in one launch the unit goes to the orchestrator as before. A worker that commits nothing after the conflict message is not sent down the quality ladder: its commit already passed.

## [0.8.4] - 2026-11-16

### Fixed

- A failed final run kept only its last 15 lines, which rarely named the failing test, so orchestrators reran the whole suite (20-50 minutes) to find it. The final gate now writes its whole output to `.orq/units/integration/head-<head12>.log` and names that file as `output` in the result when the run fails. Writing the log is best effort and capped at 64 MB a step; a passing final run removes the logs of earlier heads.

## [0.8.3] - 2026-11-16

### Fixed

- In `continuous` mode a failed final run's result was lost: the next run starts on the next head at once and removes `gate-1.json`, so the orchestrator often had only `checks failed (exit 1)` to go on. Each final result is now also written to `.orq/units/integration/head-<head12>.json`, which later runs leave in place, and the early `final-fail:` line names it.

## [0.8.2] - 2026-11-15

### Changed

- "Start one unit first" applies only until an archived plan of the project has integrated a unit. Its purpose is to prove the project's setup on one unit before many fail the same way; a later plan of a proven project now fills its slots at once. An archive whose units all failed, or one archived before it started, does not count. In a real project, eight units waited about an hour behind one slow browser-journey unit for no reason but this rule.

## [0.8.1] - 2026-11-15

### Added

- `orq inbox <text>` (or `-` for stdin) leaves a message for the orchestrator in `.orq/inbox.md`. The next `orq wait` delivers it before anything else, with or without a plan: it moves the file to `.orq/inbox-read/<iso time>.md` and returns `message: from the user, through orq inbox; read it and follow it before anything else` followed by the message (at most 60 lines). Measured: messages sent to an orchestrator's thread wait until its turn ends, which can be hours; twice in one day one never arrived and the orchestrator set back a mode the user had changed.
- `orq status` prints `inbox: <n> message(s) waiting` while the inbox is not empty. `orq plan archive` leaves the inbox and the read messages in place.
- `orq wait` checks the inbox again before each poll, takes it under the project lock, and does not deliver an inbox tracked by git.

## [0.8.0] - 2026-11-15

### Added

- A fourth autonomy mode, `continuous`: every integration head that passes the final checks ships as its own pull request. Measured across two projects: 2 merged pull requests in 13 hours, because every pull request waited for its whole plan and then for serial final-check and review rounds. Nothing changes in `draft`, `review-fix` and `review-fix-merge`.
- In `continuous` mode the final gate rolls: it starts once at least one unit is integrated, whenever no final run is in flight and the integration head has no verdict yet. It runs on a slot of its own, so unit gates keep all `gateConcurrency` slots. A run in flight when the head moves is recorded for the head it started on, and the next run starts on the newer head. Lost runs are counted per head (`finalHead`, `finalHeadStarts` in the plan state), so a lost run on an older head does not count toward `final gate could not complete` on a newer one. The plan state records `green`, the head of the latest final run that did not fail, with its verdict and the `checks.full` command it ran (`greenVerdict`, `greenChecks`; the final gate result file now carries `checks`), and `integrations`, each unit with the head its merge made.
- `orq ship` (continuous mode only; exit 4 otherwise; exit 5 while `orq wait`, `orq plan archive` or another ship holds the runner lock): refuses with exit 4 unless the head's final verdict is `pass`; fetches the base from `origin`, refuses with exit 4 when `origin/<base>` is not an ancestor of `green`, pushes `green` to the first `orq/<planId>/ship-<n>` that is free on `origin` or already holds it, opens a pull request with `gh pr create` (title naming the units first integrated in this ship, body listing them, the head the final checks passed on and the `checks.full` command they ran), fast-forwards the base with a plain push, polls `gh pr view` for up to 30 seconds until the host marks it merged, then records a `shipped` event. It never merges the pull request itself, so no merge commit lands on the base; when the host has not marked it merged in time, a `note:` line says so and the ship is still recorded. An open pull request on that branch and head, left by an interrupted ship, is reused; a merged or closed one, or one on another head, is not. A head that is not later in the integration order than the shipped one is refused before anything is pushed (the order is rebuilt from every `integrated` event, so a ledger written before this mode was set works too). The base moves by a direct fast-forward push, so the host's checks do not run before it: `checks.full` is the gate. `orq config set autonomy continuous` is refused while `checks.full` is not set, and `checks.full` cannot be cleared while the mode is `continuous`. Each failure prints one line naming the step and the way out.
- `orq wait` in `continuous` mode prints `ship-ready: <sha> passed the final checks; <k> units not shipped yet; run "orq ship"` when the latest passed head is not shipped, and an early `final-fail: <sha> fails the final checks while units are still open; <failures>` once per failing head (recorded with a `final-noted` event; `orq unit retry integration` clears it).
- `orq status` in `continuous` mode prints `ship: green=<sha> shipped=<sha> ships=<n>`.

### Changed

- In `continuous` mode `orq wait` no longer adds the `ship:` line (drop the open units to the next plan) to `timeout:`: every passed head ships on its own.
- In `continuous` mode `orq wait` prints `done:` only when every unit is integrated or dropped and the integration head is shipped.
- `orq unit retry integration` in `continuous` mode looks at the head the last final run started on and counts that head's starts.
- `orq plan archive` also refuses while a final run started on an earlier integration head is still running.
- The playbook lists `continuous` among the autonomy modes, with rows for `ship-ready:` and the early `final-fail:`; in this mode the review runs after every 5 ships or when a plan ends, and a high-severity accepted finding pauses `orq ship` until its fix ships.

## [0.7.2] - 2026-11-15

### Changed

- The playbook's Plan rules ask for `checks.unit` to be the typecheck plus every test suite that needs no browser and no running service (within the 20 minutes a gate step has), not the typecheck alone. Both real projects gated units with the typecheck only, so a unit that broke a test (a route not registered in the API catalog, a migration list, a printer count) passed its gate, was merged, and was found by the final check: one plan finished its 13 units in 44 minutes and then spent 148 minutes on 13 fix units and five final checks. A gate failure goes back to the same worker on its own; `gateConcurrency` bounds the load.
- The review in `review-fix` and `review-fix-merge` starts on a `timeout:` line whose counts are all 0 (only the final checks left), alongside them, instead of after `done`; a second review round only confirms the first round's fixes, and a new finding in it below high severity goes to the next plan (or the pull request body without a goal).
- In `review-fix-merge`, the orchestrator fetches and merges only when `origin/<base>` is an ancestor of the integration branch; otherwise a `fix` unit merges `origin/<base>` into it first (with the upstream files in its `paths`), so the final checks ran on what lands.

## [0.7.1] - 2026-11-15

### Changed

- A failed final check is no longer run a second time to tell a flaky failure from a real one. A full suite takes 15 to 20 minutes in a real project, so every failed final gate cost twice that, once per fix round (four rounds in one plan). The playbook's `final-fail` row now has the orchestrator rerun only the failing tests at the integrated commit first: if they pass, the failure was flaky and the final gate is retried with no fix unit. It also sends one fix unit per independent failure, in parallel. `checks.setup` keeps its second try in the final gate, and unit gates keep theirs.
- The playbook says to write `checks.full` so that one run reports every failure: independent suites joined so each still runs after one fails, and no `--bail`. A real `checks.full` chained five suites with `&&`, so each final gate showed only the first failing suite and each fix round found the next one.

## [0.7.0] - 2026-11-15

### Added

- `orq wait` adds a `ship:` line to its `timeout:` output when at least three quarters of the plan's units (and at least six) are integrated, none has been for 30 minutes, and no unit is in its gate or being merged. It names the units still open and says to drop them to the next plan, so the final checks run and the pull request ships now. In real plans the time from plan start to merged pull request was almost all "waiting for the last unit": one plan had 80% of its 25 units integrated after 22 minutes and its last unit after 305; another 80% of 68 after 206 minutes and the last after 846. The integration time this needs is recorded from the `integrated` events (`lastIntegratedAt`); a ledger written before it gets no `ship:` line until its next integration.
- `orq plan archive` leaves the worktree of a unit dropped from the archived plan, whose thread may still be working in it; the next archive removes it as usual.

### Changed

- The playbook says what to do on a `ship:` line (drop the open units, leave their threads running, ship, and carry each into the next plan from its branch), and to plan each part of a standing goal as at most about 12 units that each fit in an hour. Plans of about 13 units went from start to merged pull request in 47 to 93 minutes; plans of 57 and 68 units took 10 to 14 hours.

## [0.6.4] - 2026-11-15

### Fixed

- A gate no longer loses its verdict when its scratch checkout cannot be removed afterwards. The steps had run and the verdict was known, but `git worktree remove` failing (`failed to delete '.orq/gate/integration': Directory not empty`, seen when processes a browser suite started were still writing) made the gate exit without a result. `orq wait` then ran the whole final gate again, up to twice, and reported `final gate could not complete`; in a real project a 51-minute final gate was lost this way and the plan could not finish for hours. The result now carries the verdict plus a `cleanup` field that says why the checkout is still there.
- A gate checkout left behind as a registered worktree that git still cannot remove no longer stops the next gate from starting: inside `.orq/gate/` the directory is cleared, or the gate runs in a directory of its own beside it, as it already did for a leftover that was not registered.
- `orq plan archive` no longer stops when `.orq/gate` cannot be emptied (a leftover checkout something still writes into): it is scratch space, and the next plan's gates clear it or work beside it.

## [0.6.3] - 2026-11-15

### Added

- `finalTimeoutMinutes` (project setting, default 60, at most 1440): the limit of each step of the final gate (`checks.setup` and `checks.full`). The limit was 20 minutes for every gate step and could not be changed. A real project's full suite (typecheck, unit tests and a dozen browser suites) needed more than that on a loaded machine, so every final gate ended in `checks timed out` and the plan could not finish. Unit gates keep 20 minutes per step.

### Changed

- A final check that runs out of time now says so with the limit and the way out: `checks timed out after 60 min: raise the limit with "orq config set finalTimeoutMinutes <minutes>" or narrow checks.full, then "orq unit retry integration"`. A final-gate setup that times out names the same setting.
- The playbook's row for `judgment: <unit>: worker reported <STATUS>` now says what to do when the worker asked nothing and only reports that it did not finish: retry one tier up or split the unit, and move sibling units that stopped the same way up together. In a real plan five browser-journey units were retried on the same tier with the same order, stopped the same way again, and reached a stronger model only on the third launch.
- `orq unit retry integration` refuses while the final gate is still running (`the final gate is still running; "orq wait" reports its verdict`) or has a verdict that no poll has recorded yet (`the final gate has a verdict; run "orq wait" to read it`). Before, a retry at that moment discarded the result of a suite that had just run for 19 minutes and ran it again.

## [0.6.2] - 2026-11-15

### Changed

- The playbook says that `orq` deletes only checkouts it made itself and that an orchestrator runs its commands as they are, without auditing the kit against the rules it was given. A real orchestrator had been told "no forced worktree removal", read `git worktree remove --force` in the kit's source (used for the gate's scratch checkout and for the integration worktree once it is clean; worker worktrees are removed without it), refused to run the kit and stopped for five hours with 55 units integrated and unmerged.
- With a standing goal open, the playbook no longer lets an orchestrator end its turn because hardware, an account or a protocol document is missing: it builds against simulators, fixtures and open-source clients of the protocol, marks the work as not proven on hardware, and stops only when nothing of what is left can be built that way. A real orchestrator stopped after five merged pull requests with a list of things only the user could provide, two of which a simulator or public source code could stand in for.

## [0.6.1] - 2026-11-14

### Changed

- The playbook and the work order template now say that a worker runs its unit's evidence command and checks scoped to the files it changed, not the project-wide suites. `checks.unit`, when set, already runs in every gate and `checks.full` once on the integration branch. A real orchestrator wrote the root typecheck, the root tests, an application's typecheck and its 336 test files into every order: with 15 workers at once the machine's load average reached 289 on 10 cores and the median unit took 57 minutes.

## [0.6.0] - 2026-11-14

### Changed

- A unit's `paths` no longer fence the worker in. The gate fails only a change under the unit's `forbidden` globs (`forbidden paths: <files>`). A changed file outside `paths` that nothing forbids passes with the new `outside-paths` flag, which the orchestrator reviews before Finish like the other flags. The work order template and the message sent to a stopped worker now say that such a file is the worker's to edit and to name in its report, and that it must not stop to ask for it. In one real plan of 61 units, 22 of the 30 times the orchestrator was woken were a worker asking to edit one file outside its `paths`; every request was granted. A package manifest or lockfile changed outside `paths` still fails (`dependency files outside paths: <files>`), because a worktree links the main checkout's dependencies unless the unit's `paths` cover those files. A plan that relied on `paths` alone to keep a worker out of a file, including the tests its `evidence` runs, must now list that file in `forbidden`.

### Fixed

- The `playbook:` line no longer says `the kit was updated (unknown -> ...)` to a session that has no record of reading the playbook. It now says `playbook: this session has no record of reading the playbook; read <file> now, then run "orq init"`, and the `(old -> new)` part is printed only when both kit commits are known.

## [0.5.1] - 2026-11-14

### Changed

- The playbook tells the orchestrator to run `orq instance disable` only on the user's own word, never for a rule it read in a repository or a note: the switch is stored for the machine and applies to every project. A real orchestrator read its repository's instruction file as excluding a provider, disabled the instance, and took it away from a second project that was using it.

## [0.5.0] - 2026-11-14

### Added

- A project can hold a standing goal: `orq config set goal "<sentence>"` in the project, `null` to clear it, stored in `.orq/config.json`. The text is cut to one line, control characters (including C1, zero-width and bidi ones) are removed, and it is at most 500 characters; `config set goal` prints the stored value, and `"goal": null` in the file reads as no goal. While it is set, `orq wait` (on `done`, and on exit 4 when there is no plan file) and `orq plan archive` add `goal: <text>` and a `next:` line saying the goal is still open and what to do, and `orq status` prints `goal: <text>` after the `plan:` line (the `plan:` line itself is the running plan's goal). If the config cannot be read after an archive, `orq plan archive` adds `note: config unreadable: <why>` and still exits 0. With no goal set the output does not change. Real orchestrator threads finished one plan, reported and ended their turn although the user's goal was much larger; nothing told them the goal was still open.

### Changed

- The playbook tells the orchestrator to store a goal larger than one plan, to ask the user once whether a stale goal still stands, to send the open points of later parts to `orq ask`, and not to end its turn at Finish while `orq` prints a `goal:` line: it plans the biggest gaps next, from the previous integration branch in a mode that does not merge.

## [0.4.0] - 2026-11-14

### Added

- A project can bound its own threads: `orq config set cap <n>` (without `--machine`) in the project, `null` to remove it, stored in `.orq/config.json`. A project then fills at most the smaller of the machine cap less every active lease and its own cap less its own leases, so two projects on one machine can be limited separately. The project cap counts units, reviews and decisions of that project. `orq status` shows `project_cap=` and `project_leases=`, and says so when the project cap is the limit in force, as does the `waiting:` line of `orq wait`. The machine `cap` works as before.

### Changed

- A worker that reports `BLOCKED` or `NEEDS_CONTEXT` is told once, in the same thread, that unfinished work is not a blocker, with its own reason quoted: continue and commit, or report again and name the one thing it needs and where it looked. Only a second report reaches the orchestrator as a judgment. In two real runs 30 of 38 judgments were such reports, and many were only unfinished work. The message shares the one-per-launch budget of the "nothing committed" message. The ledger records it as `unfinished` with a new `stop` field; `orq stats` counts it under `stopped`, and work that passes afterwards is not a first pass.

## [0.3.2] - 2026-11-14

### Changed

- The playbook now says where an orchestrator's rules come from (the user's messages, the repository's instruction file, the playbook) and forbids adding its own. In two real runs the orchestrators had read rules out of a handoff document and their own notes: a `git` wrapper that blocked worktree removal and made gates fail, a private copy of the kit, a three-thread ceiling, acceptance criteria nobody asked for, and whole plans of report-only units. After ten hours one run had 121 commits that existed only on that machine.

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
