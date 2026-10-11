# Third-Party Notices

MergePilot plans to adapt small parts of the following MIT-licensed projects. **No third-party code has been copied yet.** When a file is copied or adapted, it keeps its original copyright header and is listed here with the source commit or download date.

| Project | License | Copyright | Planned use | Copied files |
|---|---|---|---|---|
| [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | MIT | © 2026 DeepSeek | `LlmAdapter` contract, stream types, `LlmFailure` codes, retry policy (ADR-0003) | Design only, no code copied: `packages/engine/src/llm/` re-implements the shape of `packages/llm/llm/src` (types, adapter-failure, retry-policy) |
| dsh-plugin-subscriptions | MIT | © 2026 V1ki | Ideas only: single-flight token refresh, HTTP error taxonomy (ADR-0004). Its login paths are excluded. | — |

Excluded entirely: `dsh-claude-oauth` and every consumer-subscription login path (ADR-0004).
