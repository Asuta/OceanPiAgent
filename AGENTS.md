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
- Server-side workspace state composition lives in `src/lib/server/workspace-state.ts`, which reuses shared domain helpers and applies server-only orchestration.
- Shared server room execution flow lives in `src/lib/server/room-runner.ts`.
- Agent definition persistence and custom agent loading live in `src/lib/server/agent-registry.ts`, with workspace-backed agent files stored through `src/lib/server/agent-workspace-store.ts`.
- Tool registration is composed in `src/lib/ai/tools/index.ts` from smaller tool modules.
- Pi runtime tool wrapping and schema adaptation live in `src/lib/ai/pi-agent-tools.ts`.
- Project bootstrap/context document discovery and reads live in `src/lib/ai/project-context.ts`.
- Workspace skill catalog loading and `skills/*/SKILL.md` parsing live in `src/lib/ai/skills.ts`.
- `src/components/workspace-provider.tsx` is still the top-level client composition layer, but it is already large; prefer moving new reusable logic out instead of expanding it further.
- Client-side room behavior continues to move into focused modules under `src/components/workspace/`, especially execution in `use-room-execution.ts`, scheduling in `use-room-scheduler.ts`, persistence in `persistence.ts`, and snapshot/diff helpers in `workspace-state.ts`.

## Important Boundaries

- Do not duplicate room/workspace business rules in both client and server when a shared domain helper can be used instead.
- Keep room membership and room-management mutations converged in shared domain helpers under `src/lib/chat/workspace-domain.ts`; avoid letting similar rules drift separately in `src/lib/chat/room-actions.ts`, server reducers, and client-only helpers.
- Do not bypass `src/lib/server/room-runner.ts` by re-implementing room turn execution in API routes.
- Do not put new pure domain logic, persistence conflict handling, or reusable normalization helpers directly into `src/components/workspace-provider.tsx` when they can live in shared modules.
- Do not add more hydration, persistence, SSE reconciliation, or optimistic sync logic directly into `src/components/workspace-provider.tsx`; extract that work into focused hooks or shared helpers first.
- Do not bypass `src/lib/server/agent-registry.ts` when creating or updating custom agent definitions.
- Do not bypass the allowlisted project-context or skill loaders with ad hoc filesystem reads when the same behavior belongs in `src/lib/ai/project-context.ts` or `src/lib/ai/skills.ts`.
- Do not maintain parallel tool schemas or descriptions in multiple places when they can be derived from canonical definitions under `src/lib/ai/tools/`.
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

- Base tools: bash, shared web/custom command utilities, project-context reads, and workspace skill reads
- Room tools: room membership, room history, visible room messaging
- Cron tools: scheduled room jobs and run history
- Memory tools: per-agent memory search and file reads
- Workspace tools: private agent workspace and shared workspace operations
- Tool definitions live under `src/lib/ai/tools/`, while Pi-agent runtime wrappers live in `src/lib/ai/pi-agent-tools.ts`.

When adding a tool:

- Put it in the correct focused module under `src/lib/ai/tools/`.
- Reuse schemas and helper functions from `src/lib/ai/tools/shared.ts` when possible.
- Keep room-only behavior constrained to room-aware tool context.
- Check whether the change also requires updating `src/lib/ai/pi-agent-tools.ts` so the Pi runtime exposes the same capability and schema.
- Prefer generating or adapting Pi runtime tool metadata from the canonical `ToolDefinition` shape instead of hand-maintaining a second copy of names, descriptions, enums, and argument schemas.

## Persistence

- Local browser persistence and server workspace persistence are both in use.
- Client persistence uses local storage plus server-backed workspace envelopes fetched through `/api/workspace`.
- Server persistence uses versioned workspace envelopes and optimistic conflict handling; do not remove version conflict handling casually.
- Keep workspace conflict detection and merge heuristics narrow, explicit, and shared where possible; avoid broad `JSON.stringify` equality checks or message-only reconciliation shortcuts when changing sync behavior.
- Background server flows such as cron mutate workspace state through `src/lib/server/workspace-store.ts` instead of bypassing shared validation.
- Shared per-agent runtime history, continuation snapshots, and compaction state flow through `src/lib/server/agent-room-sessions.ts`, `src/lib/server/agent-runtime-store.ts`, and `src/lib/server/agent-memory-store.ts`.
- Custom agent profiles and prompts persist inside each agent workspace through `src/lib/server/agent-registry.ts`.
- If you change workspace shape, update validation in `src/lib/chat/schemas.ts` and check migration/hydration behavior.
- If you change room-turn application logic, keep `applyRoomTurnToWorkspace` and cron turn application paths aligned through shared helpers rather than letting them drift as near-duplicate implementations.

## Testing And Validation

Before finishing substantial changes, run:

```bash
npm run lint
npm test
npm run build
```

Current tests cover shared room domain logic, room runner behavior, workspace persistence, agent runtime persistence, and agent workspace boundaries in `tests/*.test.ts`.
Add tests when changing:

- shared room domain rules
- scheduler behavior
- room execution flow
- workspace persistence boundaries
- agent runtime persistence or compaction
- private/shared workspace filesystem boundaries

## Preferred Change Style

- Make incremental refactors instead of large rewrites.
- Reuse existing helpers before adding new parallel implementations.
- Keep module responsibilities narrow.
- Preserve existing user-visible behavior unless the task explicitly changes product behavior.

## Current Refactor Priorities

- `src/components/workspace-provider.tsx` is the main client hotspot. Treat it as a composition boundary, and keep extracting hydration, persistence, server-sync, and ephemeral streaming state into focused hooks under `src/components/workspace/`.
- `src/lib/server/room-runner.ts` is the main room-execution hotspot. Keep visible room emissions, hidden console state, receipt updates, and tool-driven room actions clearly separated; prefer extracting reducers/assemblers over extending the central turn runner.
- `src/lib/server/room-scheduler.ts` is the main scheduling hotspot. Prefer isolating pure scheduling decisions from workspace I/O and queue orchestration so abort, rerun, and superseded-turn logic stay testable.
- `src/lib/server/workspace-state.ts` and `src/components/workspace/workspace-state.ts` are the main state-reconciliation hotspots. Keep shared turn-application behavior centralized and make conflict-handling rules explicit before adding new sync paths.
- `src/lib/ai/pi-agent-tools.ts` is a maintenance hotspot because it mirrors canonical tool definitions. Prefer reducing duplication rather than extending the handwritten adapter surface.
- Large page components such as `src/components/room-detail-page.tsx` and `src/components/settings-page.tsx` should keep shedding side effects and stateful workflows into focused hooks or leaf components instead of growing in place.

## Known Project Conventions

- `workspace-provider` should compose hooks and state, and ongoing work should keep pulling logic out instead of letting it become more monolithic.
- Shared domain logic should stay serializable and framework-light.
- Room execution changes should respect the separation between visible output and internal execution.
- Room tools may emit visible room messages, silent receipt updates, or room-management actions; preserve those distinctions through the full stack.
- Project-context tools only expose allowlisted root docs and `docs/`; keep that boundary intentional when expanding context access.
- Skills are workspace content under `skills/<skill-id>/SKILL.md`; if you change how skills are discovered or injected, keep loader behavior and tool exposure aligned.
- Build currently succeeds even though Next.js prints a non-blocking dynamic import warning during page data collection; do not confuse that with a failed build.
