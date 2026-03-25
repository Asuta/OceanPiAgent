# OceanKing

一个轻量的全栈 AI Chat Starter。

第一版重点是四件事：

- 普通聊天：浏览器发消息，后端转给模型，再把回复返回前端。
- 工具调用：模型可以在推理过程中调用工具，再继续完成回答。
- 双接口模式：支持 `Chat Completions` 和 `Responses` 两种 OpenAI 接口格式，并可在 UI 中切换。
- Chat Room 封装：用户看到的是过滤后的房间消息，底层 Agent 原始输出留在内部控制台，只有显式调用 `send_message_to_room` 才会回显给人类。

## Tech Stack

- Next.js App Router
- React + TypeScript
- Node.js Route Handler
- OpenAI-compatible HTTP API
- `cheerio` for `web_fetch`
- `zod` for request and tool validation

## Current Features

- Chat UI with local browser persistence (`localStorage`)
- Streaming assistant output from the server
- Switchable OpenAI API format:
  - `chat_completions`
  - `responses`
- Provider preset selector in the UI:
  - `auto`
  - `openai`
  - `right_codes`
  - `generic`
- Tool loop on the server
- Provider compatibility layer for both API formats
- Layered UI: `Chat Room` + `Agent Console`
- Multi-agent room scheduler with per-room turn orchestration
- Workspace state sync with local persistence and server-side versioned snapshots
- Per-agent shared workspace directories under `.oceanking/workspaces/<agentId>/`
- Built-in tools:
  - `web_fetch`
  - `custom_command`
  - `memory_search`
  - `memory_get`
  - `list_attached_rooms`
  - `list_known_agents`
  - `get_room_history`
  - `create_room`
  - `add_agents_to_room`
  - `leave_room`
  - `remove_room_participant`
  - `workspace_list`
  - `workspace_read`
  - `workspace_write`
  - `workspace_delete`
  - `workspace_append`
  - `workspace_move`
  - `workspace_mkdir`
  - `shared_workspace_list`
  - `shared_workspace_read`
  - `shared_workspace_write`
  - `shared_workspace_delete`
  - `shared_workspace_append`
  - `shared_workspace_move`
  - `shared_workspace_mkdir`
  - `send_message_to_room`
  - `read_no_reply`
  - `list_cron_jobs`
  - `get_cron_job`
  - `create_cron_job`
  - `update_cron_job`
  - `pause_cron_job`
  - `resume_cron_job`
  - `delete_cron_job`
  - `run_cron_job_now`
  - `list_cron_runs`
  - `preview_cron_schedule`
- Built-in custom commands:
  - `list_commands`
  - `project_profile`
  - `current_time`
  - `web_fetch`

## Environment Variables

Copy `.env.example` to `.env.local` and fill in your values:

```bash
cp .env.example .env.local
# or on Windows PowerShell:
# Copy-Item .env.example .env.local
```

Required / supported vars:

```bash
OPENAI_API_KEY=your_api_key_here
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4.1-mini
OPENAI_PROVIDER_MODE=auto
OCEANKING_AGENT_WORKSPACE_ALLOW_OUTSIDE=false
```

Notes:

- `OPENAI_BASE_URL` is treated as an OpenAI-compatible base URL.
- If the model input in the UI is left blank, the server falls back to `OPENAI_MODEL`.
- `OPENAI_PROVIDER_MODE` supports `auto`, `openai`, `right_codes`, and `generic`.
- The UI can override `OPENAI_PROVIDER_MODE` per conversation without restarting the server.
- `Responses` mode only works if your upstream provider supports `/responses`.
- `OCEANKING_AGENT_WORKSPACE_ALLOW_OUTSIDE=false` keeps workspace tools locked to `.oceanking/workspaces/<agentId>/`; turn it on only if you explicitly want agents to reach outside their workspace roots.

## Run Locally

```bash
npm install
npm run dev
npm test
```

Open `http://localhost:3000`.

## Project Structure

```text
src/
  app/
    api/chat/route.ts        # base chat endpoint + tool loop entry
    api/room-chat/route.ts   # room transport + SSE wrapper
    api/workspace/route.ts   # versioned workspace persistence API
    globals.css              # visual system
    layout.tsx               # app shell
    page.tsx                 # main page
  components/
    workspace-provider.tsx   # top-level workspace composition layer
    workspace/
      persistence.ts         # local/server workspace persistence helpers
      room-actions.ts        # room mutation helpers
      room-stream.ts         # SSE room stream parser
      scheduler.ts           # scheduler packet helpers
      use-room-execution.ts  # room turn execution hook
      use-room-scheduler.ts  # room scheduler hook
  lib/
    ai/
      openai-client.ts       # OpenAI-compatible adapters
      skills.ts              # skill loading and filtering
      system-prompt.ts       # default system prompt
      tools/
        base-tools.ts        # common web/custom command tools
        room-tools.ts        # room-scoped agent tools
        cron-tools.ts        # cron management tools
        memory-tools.ts      # agent memory tools
        workspace-tools.ts   # private/shared workspace tools
        shared.ts            # shared tool schemas and helpers
        index.ts             # tool registry composition
        custom-commands.ts   # command dispatcher
        web-fetch.ts         # guarded webpage fetcher
    chat/
      catalog.ts             # UI-facing tool metadata
      schemas.ts             # zod schemas for workspace state
      types.ts               # shared types
      workspace-domain.ts    # shared room/workspace domain logic
    server/
      room-runner.ts         # shared room turn execution service
      workspace-store.ts     # versioned workspace persistence store
      workspace-state.ts     # server-facing workspace helpers
    shared/
      text.ts                # small text helpers
.oceanking/
  agent-runtime/            # per-agent shared runtime state
  crons/                    # scheduled job state + run history
  memory/                   # per-agent memory timeline + compactions
  workspaces/               # per-agent shared filesystem workspaces
tests/
  *.test.ts                 # workspace/domain/runner regression tests
```

## Validation Commands

```bash
npm run lint
npm test
npm run build
```

## How Tool Calling Works

### Chat Completions

1. Send visible conversation + tool definitions to `/chat/completions`
2. Stream assistant deltas to the browser while collecting any tool calls
3. If the assistant returns `tool_calls`, run them on the server
4. Append tool results as `tool` messages
5. Ask the model again
6. Repeat until the assistant returns final text
7. If the provider rejects `tools`, automatically retry with legacy `functions`

### Responses

1. Send visible conversation + tool definitions to `/responses`
2. Stream assistant deltas to the browser while collecting any `function_call` items
3. If the model returns `function_call` items, run them on the server
4. Prefer `previous_response_id` when the provider supports it
5. Fallback to replaying the prior `function_call` + `function_call_output` chain when needed
6. Auto-parse JSON or SSE payloads before returning the final assistant message

## UI Notes

- `Provider Preset` lets you force compatibility behavior without editing `.env.local`
- `Compatibility` shows the detected / applied strategy for the current upstream
- `Tool Timeline` shows each tool step, duration, arguments, and raw output
- `Chat Room` is the human-facing layer; it only shows explicit `send_message_to_room` payloads
- `Agent Console` is the internal layer; it keeps the raw assistant text and tool trace

## Chat Room Layer

1. The user sends a message into the visible `Chat Room`
2. The app forwards that message to the hidden agent session instead of directly mirroring the model output
3. The internal agent can think, call tools, and produce raw assistant text inside the `Agent Console`
4. Nothing is shown back to the room unless the agent explicitly calls `send_message_to_room`
5. The `content` field of `send_message_to_room` becomes the filtered human-visible room message

## Room Runtime Notes

- `src/lib/server/room-runner.ts` owns the shared room turn execution flow used by the room API
- `src/lib/chat/workspace-domain.ts` holds shared room/workspace domain rules reused by client and server
- `src/components/workspace-provider.tsx` now focuses on composing state, persistence, scheduler, and room execution hooks instead of owning every detail inline

## Safety Notes

- `web_fetch` only allows public `http/https` URLs
- localhost and private-network targets are blocked
- fetch has a timeout and output truncation
- workspace tools are locked to each agent's own workspace by default
- `run_shell` is intentionally not included yet

## Good Next Steps

- Add streaming output
- Add more custom commands
- Add SQLite for conversation history
- Add auth and permission rules before exposing risky tools
