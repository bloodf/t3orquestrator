# Contributing

## Run the tests

```
node --test
```

Requires Node >= 22. There is nothing to install.

## Rules

- Zero runtime and zero dev dependencies. Node built-ins only.
- ESM, `.mjs` files, no TypeScript, no build step.
- Tests first: write the test, watch it fail, then write the code. Tests use `node:test` and `node:assert/strict`.
- Small files (aim under 200 lines) and small functions (aim under 50 lines).
- Pure logic takes its inputs as arguments. I/O lives in thin, injectable functions.
- Do not mutate inputs; return new objects.
- Handle errors explicitly and fail fast with a clear one-line message.
- No model or provider names in framework code. Model and tool suggestions live only in dated suggestion files.
- Nothing personal or machine-specific in any file: no usernames, home paths, hostnames or emails.

## Commits

Conventional commits: `feat|fix|refactor|docs|test|chore(scope): description`.

## Releasing

1. Make sure `node --test` passes on `main`.
2. Move the `[Unreleased]` entries in `CHANGELOG.md` under a new `[X.Y.Z]` heading with the date.
3. Tag the release commit `vX.Y.Z` and push the tag. `orq update` moves kits to the highest `v*` tag.
4. In the next commit, set the commit SHA in the stub to the full SHA of the tagged commit. The stub is in both `BOOTSTRAP.md` and `README.md`, and the two must stay byte-identical (`test/playbook.test.mjs` checks this). The stub always points at the latest tagged commit, never at `main`.

## Welcome

Bug reports with a reproduction, fixes with a failing test, documentation corrections, and portability fixes for other platforms. Please open an issue before starting large changes.
