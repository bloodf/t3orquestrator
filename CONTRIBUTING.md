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

## Welcome

Bug reports with a reproduction, fixes with a failing test, documentation corrections, and portability fixes for other platforms. Please open an issue before starting large changes.
