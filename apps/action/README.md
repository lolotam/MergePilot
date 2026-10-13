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

## Provider keys

Set `provider` and `model` in `.mergepilot.yml` (`model` is optional only for `claude-code`), then pass that provider's key as a secret in the step's `env`. Every preset calls its fixed endpoint; only `custom` takes a server URL, from the `custom-base-url` input or `CUSTOM_LLM_BASE_URL`.

| Provider | Example `model` | Key (env) |
|---|---|---|
| `anthropic` | `claude-sonnet-5-5` | `ANTHROPIC_API_KEY` |
| `openai` | `gpt-5` | `OPENAI_API_KEY` |
| `gemini` | `gemini-3.8-flash` | `GEMINI_API_KEY` |
| `xai` | `grok-4` | `XAI_API_KEY` |
| `deepseek` | `deepseek-chat` | `DEEPSEEK_API_KEY` |
| `nvidia` | `nvidia/nemotron-3-super-120b-a12b` | `NVIDIA_API_KEY` |
| `openrouter` | `openai/gpt-5` | `OPENROUTER_API_KEY` |
| `vercel-gateway` | `anthropic/claude-sonnet-4.5` (any language model the gateway lists) | `AI_GATEWAY_API_KEY` |
| `opencode-zen`, `opencode-go` | `glm-5.3` | `OPENCODE_API_KEY` |
| `zai`, `zai-coding` | `glm-4.6` | `ZAI_API_KEY` |
| `xiaomi` | `mimo-v2.5` | `XIAOMI_API_KEY` |
| `xiaomi-token-plan`, `xiaomi-token-plan-cn` | `mimo-v2.5` | `XIAOMI_TOKEN_PLAN_API_KEY` |
| `custom` | your server's model id | `CUSTOM_LLM_API_KEY` |
| `claude-code` | optional: the CLI picks its model | `CLAUDE_CODE_OAUTH_TOKEN` |

`vercel-gateway` is the same key the Jev judge uses below: one `AI_GATEWAY_API_KEY` serves review models on `https://ai-gateway.vercel.sh/v1` and the judge on its fixed Jev endpoint.

## Jev judge (optional)

A "System One" decision model ([TypeSafe Jev](https://docs.typesafe.ai/introduction/coding-agents), ADR-0015) can check every finding before it is published and spot comments that repeat an existing MergePilot comment. It only answers typed questions and is billed on input tokens only.

```yaml
# .mergepilot.yml
judge:
  provider: openrouter        # typesafe | openrouter | vercel-gateway | opencode-zen
  model: ~typesafe/jev-latest # optional; defaults to the provider's first Jev model
  uses: [annotate, filter, dedupe] # any of annotate | filter | dedupe | consensus; [] = idle
  threshold: 0.35             # filter: drop findings whose Jev confidence is below this
  fallback:                   # optional, at most 3, tried in order when the judge before fails
    - provider: opencode-zen
      model: jev-1.13-free
```

| Provider | Jev models offered | Key (env) |
|---|---|---|
| `typesafe` | `jev-latest` | `TYPESAFE_API_KEY` |
| `openrouter` | `~typesafe/jev-latest`, `typesafe/jev-1.13` | `OPENROUTER_API_KEY` |
| `vercel-gateway` | `typesafe-ai/jev` | `AI_GATEWAY_API_KEY` |
| `opencode-zen` | `jev-1.13-free`, `jev-1.13` | `OPENCODE_API_KEY` |

- Only Jev models are accepted, and the endpoints are fixed (`baseUrl` is rejected).
- `judge.uses` is a set; pick any combination (ADR-0015 multi-use):
  - `annotate` adds `Jev confidence: 0.82` to every posted finding the judge scored.
  - `filter` drops findings below `threshold` and lists them under "Filtered by Jev (n)" in the summary. Critical and high findings are never dropped; a low-confidence one that is kept gets the confidence line.
  - `dedupe` skips a finding that repeats, in meaning, an existing MergePilot comment near it.
  - `consensus` is reserved for the coming reviewer panel; it is accepted now and does nothing yet.
- `annotate` and `filter` together still cost **one** Jev request per review: findings are filtered and every remaining one is annotated. Without either of them, no such request is sent; without `dedupe`, no duplicate-check request is sent. The summary names the active uses (`Jev uses: ...`).
- The old `mode:` still works and maps to uses: `off` → `[dedupe]`, `annotate` → `[annotate, dedupe]`, `filter` → `[filter, dedupe]`. When both are set, `uses` wins; with neither, the judge runs the duplicate check only (the old default).
- A fallback is used only after auth, rate limit / overload (after one retry), 5xx, network, timeout (20 s), or a wrong model id (422 / 404); a valid low-confidence answer is final. An entry without its key is skipped. All attempts share 60 s. The summary names the judge that answered, e.g. `Jev: opencode-zen:jev-1.13-free (fallback 1; openrouter failed: rate-limited)`.
- If every entry fails, the review is published unfiltered and the summary says `Jev judge unavailable: <code>`.
- Pass the keys as secrets, e.g. `OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}`. The log gets one `judge.call` line per attempt (provider, model, question count, time, result, tokens), never the code under review.
