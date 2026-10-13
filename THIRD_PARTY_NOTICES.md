# Third-Party Notices

MergePilot uses the following MIT-licensed references and runtime dependencies. Adapted source files retain their original notices and must be listed with their source commit or download date.

| Project | License | Copyright | Planned use | Copied files |
|---|---|---|---|---|
| [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | MIT | © 2026 DeepSeek | `LlmAdapter` contract, stream types, `LlmFailure` codes, retry policy (ADR-0003) | Design only, no code copied: `packages/engine/src/llm/` re-implements the shape of `packages/llm/llm/src` (types, adapter-failure, retry-policy) |
| dsh-plugin-subscriptions | MIT | © 2026 V1ki | Ideas only: single-flight token refresh, HTTP error taxonomy (ADR-0004). Its login paths are excluded. | — |
| [@earendil-works/pi-ai](https://github.com/earendil-works/pi/tree/main/packages/ai) | MIT | Mario Zechner | Provider-owned subscription OAuth, catalogs and streaming protocols (ADR-0019) | Runtime dependency, pinned in `packages/engine/package.json`; no source files copied |

The standalone `dsh-claude-oauth` and `dsh-plugin-subscriptions` login implementations are not included. Dashboard consumer-subscription login uses `@earendil-works/pi-ai` (MIT, Mario Zechner), also used by DeepSeek Harness, as a runtime dependency. See [subscription authentication](docs/subscription-auth.md).
