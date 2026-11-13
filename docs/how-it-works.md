# How it works

## Two halves

| The orchestrating agent | `orq` |
|---|---|
| Reads the request and recalls memory | Counts active threads against a machine-wide cap |
| Decides how many units, their paths, evidence and job class | Routes each unit to a model by job class and tier |
| Writes the plan and one work order per unit | Launches worker threads in their own git worktrees |
| Judges failures `orq` cannot resolve | Gates every result in a clean checkout |
| Opens the pull request, runs the review, merges if allowed | Merges passed units into an integration branch |

The agent follows `playbook/ORCHESTRATOR.md`. It never writes product code itself. Every change comes from a worker, so every change passes through the gate. `orq` makes no judgment calls. When something needs one, `orq wait` returns and says what.

## The life of one request

1. **Intake.** The orchestrator recalls memory once and sizes the work. The default is one unit. It fans out only for three or more independent, substantial units.
2. **Plan.** It writes `.orq/plan.json` and a work order per unit under `.orq/orders/` (at most 40 lines each). Units that could run in parallel must own disjoint `paths`. `orq plan check` validates the plan.
3. **Start.** The first `orq wait` resolves `base` (from the plan, else project config, default `main`) to a commit. It records a plan id and creates the integration branch `orq/<planId>/integration`, checked out at `.orq/integration`.
4. **Launch.** Each ready unit is routed to a model and started as a T3 thread. The thread runs in a new worktree on branch `orq/<planId>/<unit>-a<attempt>` (plus `-l<n>` on a relaunch), based on the current integration head, so it sees the work its dependencies merged. The work order is the thread's first message.
5. **Gate.** When the thread completes, a detached gate process checks the commits on the worker's branch. See [The gate](#the-gate).
6. **Integrate.** A unit that passes is merged into the integration branch. A merge conflict returns the unit to the orchestrator.
7. **Final checks.** When every unit is integrated or dropped, `checks.full` runs on the integration head. `orq wait` then returns `done` with `pass` or `no-evidence`, or `final-fail` with the failures.
8. **Finish.** The orchestrator runs `orq summary`, pushes the integration branch, and opens a draft pull request with the git-host slot. In the review modes it reviews first (see [Autonomy modes](#autonomy-modes)).

A plan can grow. Append units to `plan.json` after `done` and call `orq wait` again. The new units run, and the final checks run again on the new head.

## Where state lives

| Path | Scope | Contents |
|---|---|---|
| `~/.t3orq/kit` | machine | The kit checkout the stub cloned |
| `~/.t3orq/registry.json` | machine | Provider instances and models, tiers, health, cooldowns |
| `~/.t3orq/leases/` | machine | One file per thread `orq` started; the cap counts these |
| `~/.t3orq/config.json` | machine | `cap`, `perInstanceLimit` |
| `~/.t3orq/tools.json` | machine | Your own tool catalog, tried before the kit's |
| `.orq/config.json` | project | `autonomy`, `questions`, `base`, `checks`, resolved slots, scheduler settings, the orchestrator's own model |
| `.orq/plan.json`, `.orq/orders/` | project | The plan and its work orders |
| `.orq/ledger.jsonl` | project | Append-only event log; unit states are derived from it |
| `.orq/units/<id>/gate-<n>.json` | project | Gate result per attempt, with `.log` beside it |
| `.orq/integration/` | project | The integration worktree |
| `.orq/reviews.json`, `.orq/asks.json`, `.orq/summary.md` | project | Review threads, decisions taken by `orq ask`, and the pull request body |

Set `T3ORQ_HOME` to an absolute path to move the machine state.

`orq` adds `.orq/` to the repository's local exclude file (`info/exclude` in the git directory), not to `.gitignore`. Nothing in your tracked files changes. Workers run in their own worktrees and never see `.orq/`.

Each request gets its own plan. When a request is finished, `orq plan archive` moves that plan's state into `.orq/archive/<planId>/` and keeps its integration branch, so the next request starts a fresh plan from the base branch. It also removes the worker and review worktrees; one with uncommitted or untracked files is kept and reported, and no branch is deleted.

## Capability slots

The orchestrator uses four roles. Each one resolves to an ordered chain of tools that ends in a built-in path, which needs nothing installed.

| Slot | Used for | Built-in last path |
|---|---|---|
| `judge` | Small classification calls. It advises; it never decides a gate, merge or deletion | `self`: decide it yourself |
| `memory` | Recall at intake, retain decisions and outcomes at the end | `file`: append to and read `.orq/memory.md` |
| `code-index` | Code search before broad file reads | `search`: plain text search |
| `git-host` | Pull requests and host checks | `local`: keep the integration branch local and report it |

Candidates come from `~/.t3orq/tools.json` first, then from `playbook/tools.json`. An entry is detected by a command on `PATH` or by an MCP tool name that matches a pattern. `orq init` checks commands. `orq sync` also checks the tool names the agent passes in. `orq init` prints the first tool for each slot, and `orq config get` shows the full chains. If a tool fails, the orchestrator moves to the next one in the chain. A missing tool is never a reason to stop.

## Autonomy modes

`orq init` prints `autonomy=unset` until you choose a mode. The orchestrator asks once and stores your answer with `orq config set autonomy <mode>`.

| Mode | What the orchestrator does |
|---|---|
| `draft` | Pushes the integration branch and opens a draft pull request. You review and merge. |
| `review-fix` | Before the pull request, `orq review start` runs a reviewer on a model from another family. Findings that come with a reproducing command become `fix` units. There are at most two rounds. Then it opens a draft pull request. You merge. |
| `review-fix-merge` | As `review-fix`, then it waits for the host's checks, marks the pull request ready and merges it. |

It never force-pushes, never deletes a branch, and never bypasses a required check or branch protection, whatever the mode. If the repository has no remote, the branch stays local.

## Questions

Workers and the orchestrator hit questions the plan does not settle. By default (`questions=auto`) the user is not asked: `orq ask` starts a short read-only thread on the strongest enabled model, which answers in the user's place or escalates. It escalates only what stays with the user: data loss, money, publishing beyond the autonomy mode, or a secret or intent nothing records. When the orchestrator itself runs on the strongest enabled tier, `orq ask` tells it to decide. What cannot be decided is asked in the orchestrator's thread, never in a worker's. Answered decisions are listed in the pull request body. `orq config set questions user` sends every question to the user.

## The gate

The gate judges the committed bytes between the unit's base and the worker's branch head. Uncommitted work does not count.

1. There must be at least one commit on top of the base.
2. Every changed file must match the unit's `paths` and none of its `forbidden` globs.
3. A fresh detached checkout of the head runs `checks.setup` (skipped for a unit whose plan entry has `"setup": false`), then the unit's `evidence` command, then `checks.unit` if it is set. Each step has 20 minutes. A failed step is run once more. If it passes the second time, the gate passes with a `flaky` flag. A setup step that fails twice is not held against the unit: it goes to the orchestrator as `setup failed`, because the worker cannot fix the project's install step.

The evidence belongs in the repository: `orq plan check` warns (never fails) when a unit's evidence runs a file outside the project or under `.orq/`, since such a check is not in the worker's commit or the pull request.

The verdict is `pass` or `fail`. The final gate on the integration head runs `checks.setup` and then `checks.full`; a unit's `setup` field does not affect it. Its verdict is `no-evidence` when `checks.full` is not set.

Flags never fail the gate. They tell the orchestrator what to read before it accepts the work. `orq status` lists them per unit.

| Flag | Raised when |
|---|---|
| `skipped-test` | An added line skips or focuses a test (`.skip(`, `.only(`, `xit(`, `@pytest.mark.skip`, `t.Skip(`, `#[ignore]` and similar) |
| `placeholder` | An added line contains `TODO`, `FIXME`, `not implemented` or a similar marker |
| `deleted-test` | A test file was deleted |
| `test-weakened` | An existing test file lost lines |
| `evidence-target-changed` | The evidence command names a file that the unit modified, deleted, renamed or replaced. A file the unit added itself is not flagged |
| `flaky` | Setup, evidence or checks failed once and passed on the retry |
| `no-evidence` | The unit passed with no evidence command and no `checks.unit` |

A test file is any path under `test/`, `tests/`, `__tests__/` or `spec/`, or a name ending in `.test.*`, `.spec.*` or `_test.*`.
