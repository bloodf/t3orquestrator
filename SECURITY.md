# Security

## What the paste stub does

The stub you paste into a project causes an agent to fetch code from this repository and execute it on your machine. Treat it like any install script.

To limit the risk, the stub pins an exact commit SHA rather than a tag, because tags can be moved after the fact. Read the pinned commit before you use it.

## Worker permissions

Threads started through the T3 Code CLI run in T3's full-access runtime mode: the agent in them can edit files and run commands without an approval prompt. `orq` starts worker threads this way, each in its own git worktree. Use it only in projects where you would let an agent work unattended.

## The gate is not a sandbox

The gate checks out a worker's commit and runs `checks.setup`, the unit's `evidence` command and the project checks through a shell, as you, with your environment, credentials and network. A dependency a worker added runs its install scripts there. The fresh checkout keeps a worker's uncommitted files out of the result; it does not contain the code. For a repository you do not trust, run T3 Code and `orq` inside a container or a virtual machine.

## Shared dependency directories

To save disk, `orq` links `node_modules` from your main checkout into worker worktrees instead of installing it again. A link is a symlink whose target is always inside your main checkout. It is made only:

- in projects whose lockfile is pnpm's or bun's. Both were tested to leave the main checkout's directory intact when an install runs on a linked worktree. `npm ci` was tested to empty the directory a link points to, so npm projects are never linked; yarn is untested and is not linked either;
- where git ignores the path, and when the manifests and lockfiles match your main checkout. A unit that changes dependencies gets no link and installs its own copy;
- in a gate checkout only when no setup step runs there.

A thread can still write through a link, so a worker can change or damage the install that every other thread and your own checkout use. Workers are told not to; nothing enforces it, and the fix is to install again in your main checkout. Removing a worktree removes the link, never its target. To turn sharing off, run `orq config set share null`. Other directories (`.venv`, `vendor`) are linked only if you list them in `share` yourself.

## Updates

`orq update` moves the kit to the highest `v*` tag of this repository. Tags can be moved and are not signature-checked, so an update trusts the repository as it is at that moment. To keep the pin strict, run `orq update --check` to see the target commit, read it, then run `orq update --to <full commit SHA>`.

## Shared machine state

`~/.t3orq/registry.json` and the leases are shared by every project on the machine. `orq sync` stores the provider and model list the orchestrating agent passes to it, so an agent in one project can change routing for all of them. Run orchestrators only in projects you trust.

## Provider terms

`orq` starts automated threads on whichever provider instances T3 Code reports as available. Some subscriptions restrict automated or third-party use. Check the terms of each plan you have enabled, and run `orq instance disable <id>` for any instance you do not want automated threads on.

## Credentials

`orq` never reads, stores or forwards provider credentials. It drives only the tools you have already signed in to yourself.

## Reporting a vulnerability

Use GitHub private vulnerability reporting on this repository. Do not open a public issue for a suspected vulnerability.
