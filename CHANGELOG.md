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
- CI pins `actions/checkout` and `actions/setup-node` by commit SHA and runs on pushes to `main` and on pull requests.
