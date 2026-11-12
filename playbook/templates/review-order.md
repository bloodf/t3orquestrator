# Review order: <goal in a few words>
Review the diff `<base sha>..HEAD` in this worktree against the goal and decisions below. You did not write this code.
## Goal
<the plan goal>
## Decisions
- <decision>
## Gate flags
- <kind path detail, one per line, or "none">
## Rules
- Report findings only. Do not fix, commit or push anything.
- Every finding needs: severity (high, medium or low), file:line, what breaks, and the exact command you ran with its output. Findings without a reproduction are dropped.
- Do not report style.
- Look hardest at correctness, at tests that would still pass with the behaviour broken, and at every gate flag above.
- Do not start other agents or threads.
## Report (30 lines at most)
One block per finding:
`<severity> <file:line> — <what breaks>`
`$ <command>` then the output lines that show it.
Last line: `FINDINGS: <n>` or `NO FINDINGS`.
