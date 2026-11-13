# Example profile

This is an illustration. The machine, instances, models and families below are invented placeholders, not recommendations. Real tiers and families come from `playbook/suggestions.json` and from your corrections.

## The machine

Four provider instances are enabled in T3 Code:

| Instance | Models it lists |
|---|---|
| `provider-a` | `model-large`, `model-fast` |
| `provider-b` | `model-next`, `model-small` |
| `provider-c` | none (an agent that reports `models: []`) |
| `provider-d` | `model-large` |

For this illustration, assume the suggestion file put `provider-a` models in family `family-a` and `provider-b` models in family `family-b`. Nothing matched `provider-c`, so its family is `unknown`.

## First sync

The orchestrator calls `orchestrator_capabilities` and pipes the result to `orq sync`:

```
+instances: provider-a, provider-b, provider-c, provider-d
+models: 5
synced: 4 instances (4 enabled), 5 models (0 confirmed)
inferred: provider-a::model-fast, provider-b::model-next — set with: orq tier set <key> <1-4>
```

The suggestion file matched three models, which got suggested tiers: `model-large` 3, `model-small` 1. The other two got the inferred default of 2, and `inferred:` lists them.

## Corrections

The orchestrator knows `model-next` is the strongest model here and `model-fast` is a small one:

```
$ orq tier set provider-b::model-next 4
tier provider-b::model-next = 4 (orchestrator)
$ orq tier set provider-a::model-fast 1
tier provider-a::model-fast = 1 (orchestrator)
```

`provider-c` lists no models, so the orchestrator adds the one the user runs there:

```
$ orq model add provider-c model-agent --tier 3
added provider-c::model-agent tier=3 (user)
```

The user wants no automated threads on `provider-d`:

```
$ orq instance disable provider-d
instance provider-d: disabled by user
$ orq instance list
provider-a on models=2
provider-b on models=2
provider-c on models=1
provider-d off-user models=1
```

## How three job classes route

Tiers now: `model-next` 4; `model-large` (on `provider-a`) and `model-agent` 3; `model-fast` and `model-small` 1. `provider-d` is out.

`mechanical` (minimum tier 1) takes the smallest models first:

```
$ orq route --job mechanical
1 provider-a model-fast tier=1 family=family-a unconfirmed
2 provider-b model-small tier=1 family=family-b unconfirmed
3 provider-a model-large tier=3 family=family-a unconfirmed
4 provider-c model-agent tier=3 family=unknown unconfirmed
5 provider-b model-next tier=4 family=family-b unconfirmed
```

`implement` (minimum tier 2) skips the tier-1 models. The two tier-3 models tie, so key order decides between them:

```
$ orq route --job implement
1 provider-a model-large tier=3 family=family-a unconfirmed
2 provider-c model-agent tier=3 family=unknown unconfirmed
3 provider-b model-next tier=4 family=family-b unconfirmed
```

`review` of work written at tier 3 by `family-a` needs tier 3 or more and prefers another family. Same-family and unknown-family models move to the end:

```
$ orq route --job review --author-tier 3 --author-family family-a
1 provider-b model-next tier=4 family=family-b unconfirmed
2 provider-a model-large tier=3 family=family-a unconfirmed same-family
3 provider-c model-agent tier=3 family=unknown unconfirmed same-family
```

A model shows `confirmed` once it has passed a gate, or once `orq sync` has found a completed thread on it in this project. If `provider-a` failed twice in a row, it would cool down. `orq instance list` would then show `cooldown_until=<time>`, and its models would drop out of these lists until then.
