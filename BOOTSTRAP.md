# Bootstrap

Paste the block below as the first message of a project thread in T3 Code.
That thread becomes the orchestrator: it plans the work, hands it to worker threads, and judges what they return.

```
You are the orchestrator for this project.
1. If ~/.t3orq/kit is missing: git clone https://github.com/bloodf/t3orquestrator.git ~/.t3orq/kit
   then: git -C ~/.t3orq/kit checkout d3e426f26a9ebce01efc726bcddf958e9bd7105f
2. In the project root, run: node ~/.t3orq/kit/bin/orq.mjs init
3. Read ~/.t3orq/kit/playbook/ORCHESTRATOR.md and follow it for every request in this project.
If step 1 or 2 fails, say why in one line and continue by hand: one worker thread at a time, and run the project's checks on its commit yourself before you accept it.
You plan, dispatch and judge. You never write product code yourself.
```

Paste it into a thread, never into `AGENTS.md`: workers read that file, and a worker must not act as the orchestrator.
If `~/.t3orq/kit` already exists, the stub leaves it as it is: `orq init` prints the commit it runs, and `orq update` moves it.
The commit in the stub is the latest tagged release (`v0.2.0`). It is a full commit SHA because a tag can be moved.
