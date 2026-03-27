# Project Context

OceanKing is a pi-native assistant workspace with two layers:

- the normal chat runtime for single-thread assistant turns
- the room runtime for multi-room, tool-driven agent coordination

It now also supports workspace-backed custom agents, shared per-agent room sessions, project-context document injection, and workspace skills loaded from `skills/*/SKILL.md`.

Core architecture:

- Base system prompt assembly lives in `src/lib/ai/system-prompt.ts`.
- Prompt-time context injection lives in `src/lib/ai/runtime-hooks.ts` and `src/lib/ai/runtime-hooks.builtin.ts`.
- Direct tool definitions live under `src/lib/ai/tools/`.
- Pi runtime tool registration lives in `src/lib/ai/pi-agent-tools.ts`.
- Project bootstrap/context discovery lives in `src/lib/ai/project-context.ts`.
- Workspace skill discovery and `SKILL.md` parsing live in `src/lib/ai/skills.ts`.
- Room execution orchestration lives in `src/lib/server/room-runner.ts`.
- Shared per-agent room session persistence lives in `src/lib/server/agent-room-sessions.ts` and `src/lib/server/agent-runtime-store.ts`.
- Custom agent definitions are managed through `src/lib/server/agent-registry.ts` and exposed by `/api/agents`.
- Shared room/workspace domain rules live in `src/lib/chat/workspace-domain.ts` and `src/lib/chat/schemas.ts`.

Important runtime boundaries:

- Human-facing room output must go through `send_message_to_room`.
- Plain assistant text is not automatically visible in Chat Room mode.
- Use room, cron, memory, workspace, skill, and project-context tools instead of re-implementing room state logic in prompts.
- Project-context reads are intentionally allowlisted to root docs plus `docs/`; do not assume arbitrary repository file access belongs there.
- The same agent can be attached to multiple rooms while sharing one backend memory/runtime stream unless a feature explicitly introduces isolation.

Preferred extension paths:

- Add reusable runtime instructions as `skills/<skill-id>/SKILL.md`.
- Add local project guidance in this file or docs markdown files.
- Add or update custom agent profiles through `src/lib/server/agent-registry.ts` and `/api/agents` instead of inventing parallel storage.
- Add new first-class tools under `src/lib/ai/tools/` and mirror them in `src/lib/ai/pi-agent-tools.ts`.
