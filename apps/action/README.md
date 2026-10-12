# MergePilot GitHub Action

Multi-provider AI code review for GitHub pull requests.

## Features

- **Incremental reviews** (ADR-0012): once MergePilot has reviewed a PR, later pushes review only the new commits (GitHub compare API), while inline comments stay anchored on the PR's own diff (RIGHT side). A full review runs instead on the first review, after a force-push / rewritten history, when `.mergepilot.yml` changed, or when the compare is too large or unavailable. The review summary states which mode was used.
- **No repeated comments**: every inline comment carries a hidden fingerprint (`<!-- mp:f=… -->`); a new finding on the same file and overlapping lines with the same fingerprint or a near-identical title is not posted again, including comments posted earlier by the MergePilot GitHub App.
- **Pause / resume** from a PR comment, in English or Arabic.
- **Periodic audits** on `schedule` or `workflow_dispatch`.

## Workflow

The review job runs on `pull_request`. Pause/resume commands arrive as `issue_comment`; give them their own small job (it needs no provider key and checks out no code).

```yaml
name: MergePilot

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  issue_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write
  issues: write # pause/resume: label + reply on the PR conversation

jobs:
  review:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    timeout-minutes: 15
    concurrency:
      group: mergepilot-${{ github.event.pull_request.number }}
      cancel-in-progress: true
    steps:
      # Always the released Action, never `./`: a PR's own copy would run with your secrets.
      - uses: lolotam/MergePilot@main
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}

  command:
    if: >-
      github.event_name == 'issue_comment' &&
      github.event.issue.pull_request &&
      contains(github.event.comment.body, '@mergepilot')
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: lolotam/MergePilot@main
```

## Commands

| Command | Arabic alias | Effect |
|---|---|---|
| `@mergepilot pause` | `@mergepilot إيقاف` | Stops automatic reviews on this PR (label `mergepilot:paused`). |
| `@mergepilot resume` | `@mergepilot استئناف` | Resumes automatic reviews (removes the label). |

- Only users with **write, maintain or admin** access to the repository can pause or resume (checked with the collaborator permission API). Anyone else gets a short reply and nothing changes.
- While paused, each push is skipped and a notice is posted once per pause.
- Comments from bots, edited comments and comments on plain issues are ignored.
