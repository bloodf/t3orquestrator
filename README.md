# t3orquestrator

An orchestration kit for T3 Code. You paste a short stub into a thread, and that thread becomes an orchestrator. It plans each request, hands the work to worker threads on the models you have enabled, and judges the results. A small zero-dependency Node CLI, `orq`, does the deterministic part: it counts threads, routes models, gates results and merges them.

It is for developers who already run several coding agents through T3 Code and want them to work in parallel on one repository without overrunning the machine, and without accepting work that no test has checked.

## Paste this

Paste the stub as the first message of a thread in your project:

```
You are the orchestrator for this project.
1. If ~/.t3orq/kit is missing: git clone https://github.com/bloodf/t3orquestrator.git ~/.t3orq/kit
   then: git -C ~/.t3orq/kit checkout fdacdeca4a015da7ec4a5eab77932cb47e6c597a
2. In the project root, run: node ~/.t3orq/kit/bin/orq.mjs init
3. Read ~/.t3orq/kit/playbook/ORCHESTRATOR.md and follow it for every request in this project.
If step 1 or 2 fails, say why in one line and continue by hand: one worker thread at a time, and run the project's checks on its commit yourself before you accept it.
You plan, dispatch and judge. You never write product code yourself.
```

Never put it in `AGENTS.md`, because workers read that file (see [BOOTSTRAP.md](BOOTSTRAP.md)). The stub pins an exact commit. Read that commit before you run it: see [SECURITY.md](SECURITY.md).

## What happens after you paste

1. The thread fetches the kit and runs `orq init`. It shows which of your providers it will use, then asks you once how far it may go on its own. It can open a draft pull request. It can also have a model from another family review the work and send workers to fix the findings. Or it can also merge once the host's checks pass.
2. It syncs the providers, models and tools you have enabled. Each job is then routed to a model by job class and tier.
3. For each request it first asks you, once, the few questions that change what gets built or how it is accepted, each with the answer it will assume. Then it writes a plan, usually one unit. `orq` runs each unit in its own worker thread and git worktree. In pnpm and bun projects, worktrees link `node_modules` from your main checkout instead of installing it again.
4. `orq` gates every result: it runs the unit's evidence command in a clean checkout of the worker's commit. Passing units are merged into an integration branch. A worker that ends its turn without committing is told to continue in the same thread. A failed gate goes back to the same worker once, then to a fresh worker one tier up. Only after that does the orchestrator decide. When a thread hits a limit, fails or stops responding, the unit continues on another model from the commits that thread left.
5. Questions do not wait for you. When a worker needs a decision, the orchestrator gets it from the strongest model you have enabled (`orq ask`) and records it. Only what must stay with you reaches you, and always in the orchestrator's thread: destructive actions, spending, and anything beyond the mode you chose. Turn this off with `orq config set questions user`.
6. The orchestrator finishes in the mode you chose and reports what it decided, including the decisions taken without you. When your request is bigger than one plan, it stores that as a standing goal and keeps planning the next part until nothing of it is left to build.

Read [How it works](docs/how-it-works.md) for the full sequence.

## Requirements

- T3 Code
- Node >= 22
- git

## Status and limits

- Early release (0.x). Interfaces and file formats may change between releases.
- Tested on macOS against one T3 Code nightly. There has been no testing on Windows.
- The `t3` CLI is not a stable interface. A T3 Code update can break the adapter. [docs/t3-surface.md](docs/t3-surface.md) records the version it was verified against.
- Workers run in T3's full-access mode: they edit files and run commands without asking. Use this only in projects where you would let an agent work unattended.
- A global agent instruction file that mandates another dispatch or routing procedure conflicts with the playbook. Exempt projects that use this kit from it.
- Some providers report no model list to T3 Code. The orchestrator then asks you once for the model names you run there.
- The gate runs project code as you; it is not a sandbox. See [SECURITY.md](SECURITY.md).
- There is no token-usage accounting, because T3's CLI does not expose token usage.
- The machine-wide thread cap counts only threads `orq` started. Threads you start by hand are not counted. A project can also set its own, lower cap (`orq config set cap <n>`).
- A unit's worker worktrees are removed when the unit is integrated; its branches stay. `orq worktree prune` does the same for units integrated earlier. Review and decision worktrees, and whatever was kept, are removed at `orq plan archive`. A worktree with uncommitted or untracked files is always kept; files git ignores go with the worktree.
- A shared `node_modules` is a symlink into your main checkout: a thread can write through it. npm and yarn projects are never shared. Turn sharing off with `orq config set share null`. See [SECURITY.md](SECURITY.md).
- T3's CLI cannot set a model's reasoning effort, so every thread runs at the provider's default.
- A thread that stays silent for twice `stallMinutes` (default 20) is given up. Raise it for projects with single commands that run longer.

## Models and providers

The framework names no models or providers. It discovers what is enabled on your machine and works from that. Suggestions for specific models and tools live only in the dated files `playbook/suggestions.json` and `playbook/tools.json`. Before you let automated threads use a subscription, read [Provider terms](docs/provider-terms.md).

## Documentation

- [How it works](docs/how-it-works.md): the agent and `orq`, the life of a request, state, slots, autonomy modes, the gate
- [Scheduling](docs/scheduling.md): unit states, the cap, failure handling, what `orq wait` returns
- [Commands](docs/commands.md): every `orq` command, its output and exit codes
- [Provider terms](docs/provider-terms.md): accounts, credentials and automated use
- [Example profile](docs/example-profile.md): a worked illustration of sync, tiers and routing
- [T3 surface](docs/t3-surface.md): what was observed of the T3 Code CLI and tools

## Project

- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE)
