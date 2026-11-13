# Provider terms

Nothing here is legal advice.

## What `orq` does with your accounts

- It drives only the coding-agent tools you have already signed in to yourself through T3 Code. It starts threads through T3, the same way you would by hand.
- It never reads, stores or forwards credentials, API keys or session tokens.
- It never creates accounts and never shares an account between users.
- When an instance fails or hits a usage limit, `orq` cools that instance down and routes work to the other instances you have enabled.
- `orq` does not know which account is behind an instance. If you have set up several accounts of the same provider as separate instances in T3 Code, `orq` treats each as its own instance and will move work from one to another when the first is limited. Whether that is allowed is a question for that provider's terms. If it is not, disable the extra instances.

## What you must check

Some subscriptions restrict automated use or use through third-party tools. Some limit how many sessions run at once. Providers have enforced such terms by suspending accounts. Before you let `orq` start threads on an instance, read the terms of the plan behind it and decide whether unattended, parallel use is allowed.

Your provider's terms decide what is allowed. This kit does not, and neither do these documents. Terms change, so check them again when you change plans.

## Keeping an instance out

```
orq instance list
orq instance disable <id>
```

A disabled instance shows as `off-user`. It takes no automated work, and `orq sync` never re-enables it. You can still use it by hand in T3. `orq instance enable <id>` reverses it.

You can also lower `perInstanceLimit` (`orq config set --machine perInstanceLimit 1`) to cap how many threads run on any one instance at once.
