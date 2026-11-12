# Security

## What the paste stub does

The stub you paste into a project causes an agent to fetch code from this repository and execute it on your machine. Treat it like any install script.

To limit the risk, the stub pins an exact commit SHA rather than a tag, because tags can be moved after the fact. Read the pinned commit before you use it.

## Worker permissions

Threads started through the T3 Code CLI run in T3's full-access runtime mode: the agent in them can edit files and run commands without an approval prompt. `orq` starts worker threads this way, each in its own git worktree. Use it only in projects where you would let an agent work unattended.

## Credentials

`orq` never reads, stores or forwards provider credentials. It drives only the tools you have already signed in to yourself.

## Reporting a vulnerability

Use GitHub private vulnerability reporting on this repository. Do not open a public issue for a suspected vulnerability.
