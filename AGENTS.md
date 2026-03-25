# AGENTS.md

Repository guidance for coding agents working in this project.

## What This App Is

- Human-facing communication happens in `Chat Room`.
- Raw assistant reasoning, tool traces, and internal turn flow stay in `Agent Console`.
- Agents must not assume assistant text is visible to humans.
- Human-visible room output should only appear through explicit room message emissions such as `send_message_to_room`.

## Core Architecture

- Shared room and workspace domain rules live in `src/lib/chat/workspace-domain.ts`.
- Workspace state validation lives in `src/lib/chat/schemas.ts`.
- Shared server room execution flow lives in `src/lib/server/room-runner.ts`.
- Tool registration is composed in `src/lib/ai/tools/index.ts` from smaller tool modules.
- `src/components/workspace-provider.tsx` is the composition layer for client state and hooks. Keep it thin.
- Client-side room behavior is being split into focused modules under `src/components/workspace/`.

## Important Boundaries

- Do not duplicate room/workspace business rules in both client and server when a shared domain helper can be used instead.
- Do not bypass `src/lib/server/room-runner.ts` by re-implementing room turn execution in API routes.
- Do not put new pure domain logic directly into `src/components/workspace-provider.tsx`.
- Prefer extracting reusable logic into:
  - `src/lib/chat/` for shared domain logic and schemas
  - `src/lib/server/` for server orchestration and persistence
  - `src/components/workspace/` for client hooks and helpers

## Messaging Model

- A room message is not the same thing as an agent console turn.
- Scheduler packets are internal system messages used to drive room-agent turns.
- Receipt updates such as `read_no_reply` are meaningful state transitions and should not be treated as normal visible replies.
- Be careful to preserve the distinction between:
  - visible room transcript
  - hidden console transcript
  - tool-emitted room actions

## Tools

- Base tools: shared web/custom command utilities
- Room tools: room membership, room history, visible room messaging
- Cron tools: scheduled room jobs and run history
- Memory tools: per-agent memory search and file reads
- Workspace tools: private agent workspace and shared workspace operations

When adding a tool:

- Put it in the correct focused module under `src/lib/ai/tools/`.
- Reuse schemas and helper functions from `src/lib/ai/tools/shared.ts` when possible.
- Keep room-only behavior constrained to room-aware tool context.

## Persistence

- Local browser persistence and server workspace persistence are both in use.
- Server persistence uses versioned workspace snapshots; do not remove version conflict handling casually.
- If you change workspace shape, update validation in `src/lib/chat/schemas.ts` and check migration/hydration behavior.

## Testing And Validation

Before finishing substantial changes, run:

```bash
npm run lint
npm test
npm run build
```

Current tests cover workspace/domain/runner behavior in `tests/*.test.ts`.
Add tests when changing:

- shared room domain rules
- scheduler behavior
- room execution flow
- workspace persistence boundaries

## Preferred Change Style

- Make incremental refactors instead of large rewrites.
- Reuse existing helpers before adding new parallel implementations.
- Keep module responsibilities narrow.
- Preserve existing user-visible behavior unless the task explicitly changes product behavior.

## Known Project Conventions

- `workspace-provider` should compose hooks and state, not become a new monolith.
- Shared domain logic should stay serializable and framework-light.
- Room execution changes should respect the separation between visible output and internal execution.
- Build currently succeeds even though Next.js prints a non-blocking dynamic import warning during page data collection; do not confuse that with a failed build.
