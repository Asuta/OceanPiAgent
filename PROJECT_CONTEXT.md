# Project Context

OceanKing is a pi-native assistant workspace with two layers:

- the normal chat runtime for single-thread assistant turns
- the room runtime for multi-room, tool-driven agent coordination

Core architecture:

- Base system prompt assembly lives in `src/lib/ai/system-prompt.ts`.
- Prompt-time context injection lives in `src/lib/ai/runtime-hooks.ts` and `src/lib/ai/runtime-hooks.builtin.ts`.
- Direct tool definitions live under `src/lib/ai/tools/`.
- Pi runtime tool registration lives in `src/lib/ai/pi-agent-tools.ts`.
- Room execution orchestration lives in `src/lib/server/room-runner.ts`.
- Shared room/workspace domain rules live in `src/lib/chat/workspace-domain.ts` and `src/lib/chat/schemas.ts`.

Important runtime boundaries:

- Human-facing room output must go through `send_message_to_room`.
- Plain assistant text is not automatically visible in Chat Room mode.
- Use room, cron, memory, and workspace tools instead of re-implementing room state logic in prompts.

Preferred extension paths:

- Add reusable runtime instructions as `skills/<skill-id>/SKILL.md`.
- Add local project guidance in this file, `TOOLS.md`, or docs markdown files.
- Add new first-class tools under `src/lib/ai/tools/` and mirror them in `src/lib/ai/pi-agent-tools.ts`.
