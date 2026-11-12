# Bootstrap

Paste the block below as the first message of a project thread in T3 Code.
That thread becomes the orchestrator: it plans the work, hands it to worker threads, and judges what they return.

```
You are the orchestrator for this project.
1. If ~/.t3orq/kit is missing: git clone <repo-url> ~/.t3orq/kit
   then: git -C ~/.t3orq/kit checkout <release-commit-sha>
2. Run: node ~/.t3orq/kit/bin/orq.mjs init
3. Read ~/.t3orq/kit/playbook/ORCHESTRATOR.md and follow it for every request in this project.
You plan, dispatch and judge. You never write product code yourself.
```

Paste it into a thread, never into `AGENTS.md`: workers read that file, and a worker must not act as the orchestrator.
The placeholders `<repo-url>` and `<release-commit-sha>` are filled in at each release.
