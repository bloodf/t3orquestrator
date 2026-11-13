# t3orquestrator

An orchestration kit for T3 Code. You paste a short stub into a thread, and that thread becomes an orchestrator. It plans each request, hands the work to worker threads on the models you have enabled, and judges the results. A small zero-dependency Node CLI, `orq`, does the deterministic part: it counts threads, routes models, gates results and merges them.

It is for developers who already run several coding agents through T3 Code and want them to work in parallel on one repository without overrunning the machine, and without accepting work that no test has checked.

## Paste this

Paste the stub as the first message of a thread in your project:

```
You are the orchestrator for this project.
1. If ~/.t3orq/kit is missing: git clone https://github.com/bloodf/t3orquestrator.git ~/.t3orq/kit
   then: git -C ~/.t3orq/kit checkout 0de35418de28777c819d0e128169ab59465d22ee
2. In the project root, run: node ~/.t3orq/kit/bin/orq.mjs init
3. Read ~/.t3orq/kit/playbook/ORCHESTRATOR.md and follow it for every request in this project.
If step 1 or 2 fails, say why in one line and continue by hand: one worker thread at a time, and run the project's checks on its commit yourself before you accept it.
You plan, dispatch and judge. You never write product code yourself.
```

Never put it in `AGENTS.md`, because workers read that file (see [BOOTSTRAP.md](BOOTSTRAP.md)). The stub pins an exact commit. Read that commit before you run it: see [SECURITY.md](SECURITY.md).

## What happens after you paste

1. The thread fetches the kit and runs `orq init`. Then it asks you once how far it may go on its own. It can open a draft pull request. It can also have a model from another family review the work and send workers to fix the findings. Or it can also merge once the host's checks pass.
2. It syncs the providers, models and tools you have enabled. Each job is then routed to a model by job class and tier.
3. For each request it writes a plan, usually one unit. `orq` runs each unit in its own worker thread and git worktree.
4. `orq` gates every result: it runs the unit's evidence command in a clean checkout of the worker's commit. Passing units are merged into an integration branch. A failed gate goes back to the same worker once, then to a fresh worker one tier up. Only after that does the orchestrator decide.
5. The orchestrator finishes in the mode you chose and reports what it decided.

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
- The machine-wide thread cap counts only threads `orq` started. Threads you start by hand are not counted.
- Worker and review worktrees are removed at `orq plan archive`. One with uncommitted or untracked files is kept and reported.

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
