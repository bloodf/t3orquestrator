# Scheduling

`orq wait` runs the scheduler. It polls every `pollSeconds` (default 15). On each poll it reads the project's threads from T3, updates the unit states, starts gates, merges passed units and launches ready ones. It returns when something needs the orchestrator, or after `--max-seconds` (default 480). Only one `orq wait` runs per project at a time. Gates run as detached processes, so they keep running after `orq wait` returns.

## Unit states

```
            launched / feedback sent
  queued ─────────────────────────────▶ running ◀──▶ blocked
    ▲  ▲                                  │  │  pending request
    │  └──── provider failure ────────────┘  │
    │                                        │ thread completed
    │        gate failed (attempt 1 or 2)    ▼
    └─────────────────────────────────── gating ──▶ passed ──▶ integrated
                                                     gate passed   merged

  any open state ──▶ failed (needs judgment) ──orq unit retry──▶ queued
  any open state or failed ──orq unit drop──▶ dropped
```

| State | Holds a slot under the cap | What moves it on |
|---|---|---|
| `queued` | No | Its `deps` are integrated, a model is routable and a slot is free. A unit whose first gate failed waits here for a slot, then its failures are sent to the same thread |
| `running` | Yes | The thread completes (to `gating`), fails, is cancelled, is interrupted or disappears (back to `queued`), or asks a question (to `blocked`) |
| `blocked` | No; the lease stays but is marked blocked | The question is answered (to `running`) |
| `gating` | No; gates are limited by `gateConcurrency` (default 1 per project) | The gate result: `pass` or `no-evidence` to `passed`, `fail` back to `queued` or to `failed` |
| `passed` | No | The merge into the integration branch (to `integrated`), or a conflict (to `failed`) |
| `integrated` | No | Final |
| `failed` | No | `orq unit retry <id>` (to `queued`, or to `gating` after a setup failure) or `orq unit drop <id>` |
| `dropped` | No | Final |

Every transition is an event in `.orq/ledger.jsonl`. The state is derived from the events, and an illegal transition is rejected before anything is written.

## The cap

The cap is the number of threads `orq` lets run at once on the machine, across all projects.

- **Computed:** the smaller of half the CPU cores and available memory divided by 2 GiB. It is reduced by one when the 1-minute load is above 0.7 per core, and kept between 1 and 8. `orq probe` prints the value and the reason.
- **Override:** `orq config set --machine cap <n>`.
- **Per instance:** at most `perInstanceLimit` threads per provider instance (default 2, `orq config set --machine perInstanceLimit <n>`).

The cap counts leases in `~/.t3orq/leases/`. `orq` writes one per thread it starts, including review threads. A reservation lease also counts while a thread is being started. Active means a live lease that is not blocked. These do not count:

- a thread waiting on a question (`blocked`);
- gates, which hold no lease;
- instances cooling down, which hold no thread;
- threads you started by hand.

Each poll of `orq wait` refreshes the heartbeat on its project's leases. A lease whose heartbeat is older than `leaseTtlMinutes` (default 30) is expired and holds no slot. A lease left by a crashed run therefore frees itself. A reservation that never became a thread expires after 2 minutes. The same pass removes leases whose unit is no longer running. If that unit's thread is still running, `orq wait` prints a note telling you to interrupt it.

## Start one unit first

Until some unit has passed its gate, only one unit is in flight. A plan with a bad assumption, a wrong check command or a model that cannot do the job fails once, not in parallel. After the first pass, ready units launch as slots free, in plan order.

## Routing

`orq` picks a model for each launch from `playbook/routing.json`. Each job class has a minimum tier (4 strongest, 1 smallest). `review` and `fix` use the author's tier: the highest tier among the integrated units. `review` also prefers a different model family.

Among enabled, available models at or above the minimum tier, candidates are ordered by:

1. lowest tier first;
2. then fewest running threads on that instance;
3. then least recently used;
4. then key order.

For `review`, models from the author's family, and models whose family is unknown, move to the end. If no model reaches the minimum tier, the best available tier is used and `orq route` marks it `below-tier`. A unit launched that way, including a `fix` unit that cannot get the author's tier, gets a `note: unit <id> wanted tier <n>; launched on <key> (tier <m>), the best available` line from `orq wait`, and `wanted_tier=<n>` in `orq status`.

A model is skipped while it or its instance is cooling down, or while its instance is at its limit. A model whose work failed the gate twice for this unit is excluded for that unit (the quality ladder's third attempt). A model or instance on which this unit hit a provider failure moves to the end of the order, a failed model behind a failed instance, but it is not excluded: when nothing else is eligible it is used again once its cooldown has passed.

## Failure ladders

There are two ladders: one for when the provider fails, one for when the work fails.

**Provider failure.** The thread ended `failed`, `cancelled` or `interrupted`, disappeared, or did not start. The work is not judged.

1. The unit goes back to `queued` on the same attempt. The failed model and its instance move to the end of the order for this unit. With a single routable model the unit waits out that model's cooldown (`idle: … retry at <time>`) and runs on it again.
2. The model cools down for 10 minutes, doubling with each consecutive failure, up to 5 hours.
3. After two consecutive failures on the same instance, the whole instance cools down, starting at 10 minutes. Treating it as down covers quota limits and outages, because T3 does not report why a thread failed.
4. A thread that completes on the instance clears its failure count. A gate pass clears the model's failure count.
5. After 3 provider failures the unit goes to `failed`. When the quality ladder has excluded every eligible model, it goes to `failed` with `no model available: all excluded`. When some eligible models are excluded and the rest are cooling down (`none eligible: excluded, cooling down`), the unit waits for the cooldown.

Feedback can also go unseen. If the thread still shows its run from before the failures were sent, `orq wait` reports it as stalled after 2 minutes. It treats it as a provider failure after `stallMinutes`.

**Gate failure.** The work was judged and rejected.

| Attempt that failed | Next |
|---|---|
| 1 | The failures are sent back to the same thread: "The gate rejected this work: … Fix it, commit, and report." This takes a slot. |
| 2 | A fresh thread on a different model, at least one tier up (at most 4). The failures go at the top of its work order. |
| 3 | `failed` with `gate failed 3 times: <failures>` |

A gate that started twice without producing a result goes to `failed` with `gate could not complete`, followed by `: <last line the gate process logged>` when it logged one.

**Setup failure.** `checks.setup` is retried once like the other steps; a pass on the retry adds a `flaky` flag. When it still fails, that is a fact about the project, not the unit: the unit goes straight to `failed` with `setup failed (exit <n>)[: <last output line>]`, or `setup timed out[: <last output line>]`. Nothing is sent to the worker, nothing is relaunched, and no attempt is counted. Fix the setup, then `orq unit retry <id>` gates the unit's branch again (its current head; no new worker runs, so `--tier` is refused). The final gate works the same way: `judgment: integration: setup failed …`, then `orq unit retry integration`.

## What `orq wait` returns

The first line is one of the forms below. Notes and detail lines follow it. Output is held to 7 lines by cutting notes only: when they do not fit, the ones that do are followed by `note: <n> more notes omitted`. Decision lines (one per failed or blocked unit, `stalled:`, `waiting:`) are never cut, so with many of them the output is longer than 7 lines. The exit code is 0 for all of them.

| First line | Meaning |
|---|---|
| `done: <n> units integrated at <sha>; final checks <pass\|no-evidence\|none>` | Every unit is integrated or dropped, and the final checks ran on the current integration head. `none` means nothing was integrated. |
| `final-fail: <n> units integrated at <sha>; <failures>` | Every unit is integrated or dropped, but the final checks failed on the current integration head. The run is not done. Append a `fix` unit to the plan, or, when the failure predates the request, narrow `checks.full` and run `orq unit retry integration`: the final gate runs again on the same head with the current `checks.full`. |
| `judgment: <unit>: <reason>` | A unit is `failed`. Each further failed unit is listed on its own line as `<unit>: <reason>`. Reasons: `gate failed 3 times: …`, `3 provider failures`, `no model available: …`, `merge conflict: <files>`, `integrate failed: …`, `gate could not start: …`, `gate could not complete[: <line>]`, `setup failed (exit <n>)[: <line>]`, `setup timed out[: <line>]`, `depends on dropped unit <id>`, `worker reported <BLOCKED\|NEEDS_CONTEXT>: <detail>` (the worker's reply asked the orchestrator; no gate ran). The unit `integration` with `final gate could not complete[: <line>]` or a setup reason means the final gate; `orq unit retry integration` restarts it. |
| `blocked: <unit> waiting on a request in thread <id>` | A worker asked a question. Read it with the T3 pending-request tool. |
| `idle: no model for <unit>: <reason>[; retry at <time>]` | No model can take the unit now (cooling down, at limit, or none in the registry). |
| `idle: <n> queued units wait on dependencies that will not finish` | A dependency failed. (A unit whose dependency was dropped goes to `judgment:` with `depends on dropped unit <id>` instead.) |
| `idle: nothing left to launch` | Nothing is running and nothing can start. |
| `timeout: <n> running, <n> blocked, <n> gating, <n> queued, <n> passed` | `--max-seconds` passed. Lines `stalled: <unit> thread <id> quiet for <n> min` name threads with no update for `stallMinutes` (default 20). A line `waiting: <n> ready units wait for a slot; every machine slot is held (cap <n>)` means units could launch but every slot under the machine cap is taken (by other projects, or by this project's own review thread): `orq wait` keeps polling while that lasts instead of returning, so call it again. Units that only wait on dependencies are not counted. |

Exit code 4 with `no valid plan; run "orq plan check"` means the plan failed validation. Exit code 5 means another `orq wait` is running for this project.

## Scheduler settings

Project settings, set with `orq config set <key> <n>`:

| Key | Default |
|---|---|
| `pollSeconds` | 15 |
| `stallMinutes` | 20 |
| `gateConcurrency` | 1 |
| `leaseTtlMinutes` | 30 |

## Known limits

- When a blocked thread resumes, it takes its slot back even if the cap is full. Each thread that resumes this way can push the count one over the cap until something finishes.
- A crash between T3 starting a thread and `orq` recording its lease can leave one extra thread. Its reservation expires after 2 minutes and the unit launches again, so that work runs twice. The first thread keeps running untracked until you interrupt it.
- A dropped unit's thread keeps running in T3. `orq unit drop` prints its id so you can stop it.
- T3 does not report why a thread failed, so a wrong model name and a provider outage look the same. Both lead to a cooldown.
