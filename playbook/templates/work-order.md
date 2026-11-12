# Work order: <unit id> — <title>
## Goal
<One or two sentences: the outcome when this is done, not the activity.>
## Context
- <file path to start from>
- Decision: <a decision from the plan that applies here>
- Code search: <the code-index tool and how to call it, or "plain text search">
## Do
1. <step; numbered steps for the smallest models, otherwise delete this section>
- Do not <thing>.
## Constraints
- <rule, with its reason in a clause>
## You may write
- <glob>
## You must not touch
- <glob>
## Done when
`<evidence command>` exits 0. It will be run for you in a clean checkout of your commit.
## Out of scope
- <work a reasonable worker might do that this unit must not>
## Rules
- Commit your work on this branch before you report. Only committed work counts.
- Stay inside the writable paths.
- Do not weaken, skip or delete tests to make the command pass.
- Do not start other agents or threads.
- Use the code search tool named in Context before reading many files.
- If you cannot finish, say so. Bad work is worse than no work.
## Report (30 lines at most)
First line: one of `DONE`, `DONE_WITH_CONCERNS`, `BLOCKED`, `NEEDS_CONTEXT`.
Then: the files you changed; the evidence command and the last lines of its output; your concerns.
