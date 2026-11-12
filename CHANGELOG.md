# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
- CI pins `actions/checkout` and `actions/setup-node` by commit SHA and runs on pushes to `main` and on pull requests.
