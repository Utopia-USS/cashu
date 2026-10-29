# Local interview notes

What this is: where the interview's working notes live and what each file holds.

The strategy, its versions, decisions, theses and reviews live in the app (written through MCP). Your
own working notes live in the profile's agent workspace, in `notes/interview/` (the workspace's
`CLAUDE.md` says where notes go; reads of the cashU data dir are denied there). Outside a cashU
workspace, ask the user for a local folder outside any repository and outside the cashU data dir, or
suggest creating the workspace first (Ustawienia > Agent AI).

```
notes/interview/
  interview-state.md        phase checklist with the actual order, where we stopped, open questions,
                            working decisions of the current phase, privacy level used
  situation.md              facts with "as of" dates, one section per phase 1/2/3/5
  history-retrospective.md  phase 4: facts, user context, failure modes, strengths
  special-<topic>.md        one file per time-sensitive individual issue
```

Files are in English (quotes of the user's words may stay Polish). In strict mode they hold relative
values only, unless the user agreed to note amounts.
