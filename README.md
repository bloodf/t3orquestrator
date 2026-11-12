# t3orquestrator

An orchestration stack for T3 Code. A small zero-dependency Node CLI, `orq`, does the deterministic half of orchestration: sizing how many agent threads may be active, tracking state and routing work. The orchestrating agent does the judgment half.

Status: Pre-release: under construction, not yet usable.

## How it will work

Paste this stub into a project's first prompt:

```
You are the orchestrator for this project.
1. If ~/.t3orq/kit is missing: git clone <repo-url> ~/.t3orq/kit
   then: git -C ~/.t3orq/kit checkout <release-commit-sha>
2. Run: node ~/.t3orq/kit/bin/orq.mjs init
3. Read ~/.t3orq/kit/playbook/ORCHESTRATOR.md and follow it for every request in this project.
You plan, dispatch and judge. You never write product code yourself.
```

## Requirements

- T3 Code
- Node >= 22
- git

## Models and providers

The framework names no models or providers. It discovers what is enabled on your machine and works from that. Suggestions for specific models or tools live only in dated suggestion files, never in framework code.

## Project

- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)

## License

[MIT](LICENSE)
