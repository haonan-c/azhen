# Issue tracker: GitHub

Issues and specs for this repository live in GitHub Issues in `haonan-c/azhen`. Use the `gh` CLI
for all operations.

## Conventions

- Create: `gh issue create --title "..." --body "..."`
- Read: `gh issue view <number> --comments`
- List: `gh issue list --state open --json number,title,body,labels,comments`
- Comment: `gh issue comment <number> --body "..."`
- Apply labels: `gh issue edit <number> --add-label "..."`
- Remove labels: `gh issue edit <number> --remove-label "..."`
- Close: `gh issue close <number> --comment "..."`

Infer the repository from `git remote -v`.

## Pull requests as a triage surface

PRs as a request surface: no.

## Skill operations

- "Publish to the issue tracker" means create a GitHub Issue.
- "Fetch the relevant ticket" means read the Issue and its comments.
- Use GitHub native issue dependencies for blocking relationships.
- If native dependencies are unavailable, add `Blocked by: #<number>` to the Issue body.
- A task is ready only when all blocking Issues are closed.
