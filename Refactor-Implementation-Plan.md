# OceanPiAgent Refactor Implementation Plan

## Purpose

This document records the current refactor plan for OceanPiAgent and turns the high-level review into an implementation checklist that can be executed incrementally.

The goal is not a rewrite. The goal is to reduce maintenance risk in the current hotspots while preserving user-visible behavior and keeping the project shippable after every step.

## Current Assessment

The codebase already has good domain separation in several places, but a few high-traffic modules have accumulated too many responsibilities:

- `src/components/workspace-provider.tsx` mixes hydration, browser persistence, server persistence, conflict handling, SSE sync, room-stream orchestration, and a large context surface.
- `src/lib/server/room-runner.ts` acts like a large state machine for streaming text, tool side effects, room message streams, receipts, and error handling.
- `src/lib/server/room-scheduler.ts` performs several full workspace reads and writes in a single scheduling loop and coordinates concurrency through a process-global queue map.
- `src/lib/server/workspace-state.ts` contains duplicated turn-application logic for normal room turns and cron turns.
- `src/lib/ai/tools/` and `src/lib/ai/pi-agent-tools.ts` maintain parallel tool schemas and catalog definitions, which creates drift risk.
- Large page components such as `src/components/room-detail-page.tsx` and `src/components/settings-page.tsx` combine UI composition with substantial stateful workflow logic.

## Refactor Principles

- Prefer incremental extractions over large rewrites.
- Keep behavior stable unless a task explicitly changes product behavior.
- Add tests before changing fragile orchestration paths.
- Favor shared domain helpers over parallel client/server or runtime-specific implementations.
- Keep provider and page components as composition boundaries, not logic sinks.
- Reduce duplication before introducing new abstractions.

## Priority Order

1. Add missing tests and protective coverage.
2. Remove obvious duplicated logic in shared workspace turn application.
3. Reduce room-scheduler persistence churn and queue coupling.
4. Split `room-runner` into focused accumulator/reducer-style helpers.
5. Break `workspace-provider` into focused hooks and smaller contexts.
6. Split large page components into smaller state and view modules.
7. Canonicalize tool schemas and generate runtime adapters from one source.
8. Unify room-management rules across persisted workspace and attached-room tool context.

## Phased Implementation Plan

### Phase 0: Test Guardrails

Goal: make the current behavior safer to refactor.

Planned work:

- Expand `tests/workspace-state.test.ts` to cover `applyCronTurnToWorkspace`.
- Expand `tests/room-service.test.ts` beyond `send_message` to include archive/restore/clear and participant mutations.
- Add queue behavior coverage for repeated `enqueueRoomScheduler` calls with overlapping overrides.
- Add parity coverage for the Pi tool registry versus the canonical tool registry.

Done when:

- The major orchestration branches have direct tests rather than only happy-path coverage.
- Refactors in later phases can be validated without relying on manual inspection alone.

### Phase 1: Shared Workspace Turn Application

Goal: remove duplicated logic in `src/lib/server/workspace-state.ts`.

Planned work:

- Extract a shared internal helper that applies agent-turn-like updates.
- Keep `applyRoomTurnToWorkspace` and `applyCronTurnToWorkspace` as thin wrappers.
- Extract shared cross-room emitted-message fanout logic.
- Keep the only wrapper-specific difference explicit: normal room turns replace the initiating user message while cron turns do not.

Done when:

- The duplicated room-turn and cron-turn update paths are consolidated.
- Existing behavior remains unchanged and is covered by tests.

### Phase 2: Room Service Cleanup

Goal: simplify room command orchestration in `src/lib/server/room-service.ts`.

Planned work:

- Introduce a shared `updateRoomById` helper for repeated room mutation patterns.
- Replace inline timestamps with the shared timestamp helper.
- Break command handling into smaller handlers while keeping `runRoomCommand` as orchestration.

Done when:

- Command branches are shorter and more uniform.
- Common mutation patterns do not need to be re-implemented per branch.

### Phase 3: Scheduler Simplification

Goal: reduce write amplification and clarify concurrency behavior in `src/lib/server/room-scheduler.ts`.

Planned work:

- Extract pure scheduling decision helpers such as selecting the next participant and building a round plan.
- Collapse repeated load/mutate cycles where possible.
- Introduce an explicit scheduler queue abstraction around the current global map.
- Define and test queue override merge semantics.
- Inject follow-up scheduling instead of hard-calling module-level scheduling functions.

Done when:

- A scheduler round performs fewer workspace rewrites.
- Queue behavior is explicit and testable.

### Phase 4: Room Runner Accumulator

Goal: split `src/lib/server/room-runner.ts` into focused state transition helpers.

Planned work:

- Extract a room-turn accumulator module for draft deltas, tool events, room message streams, and receipt updates.
- Centralize assistant meta shaping across success and error paths.
- Keep `runPreparedRoomTurn` as orchestration plus callback wiring.

Done when:

- The main runner becomes shorter and easier to reason about.
- Fine-grained state transitions can be tested directly.

### Phase 5: Workspace Provider Decomposition

Goal: turn `src/components/workspace-provider.tsx` back into a composition boundary.

Planned work:

- Extract `useWorkspaceHydration`.
- Extract `useWorkspacePersistence`.
- Extract `useWorkspaceStreamSync`.
- Extract `useRoomStreamingSend`.
- Split the large context into smaller contexts or selector hooks for rooms, agents, actions, and high-churn ephemeral state.

Done when:

- The provider file primarily wires hooks and context values together.
- Streaming updates no longer force unrelated consumers to rerender as broadly.

### Phase 6: Client Page Decomposition

Goal: reduce page-level complexity in `room-detail-page` and `settings-page`.

Planned work for `src/components/room-detail-page.tsx`:

- Extract room-detail derived state hooks.
- Extract message attachment/upload handling.
- Split thread view, composer, and workbench/console panels into leaf components.

Planned work for `src/components/settings-page.tsx`:

- Extract model-config CRUD hook.
- Extract runtime polling hook.
- Extract agent-editor draft hook.
- Split the tab bodies and large agent cards into focused components.

Done when:

- Page files mainly coordinate layout and local view state.
- Runtime polling does not affect unrelated parts of the settings view more than necessary.

### Phase 7: Tool Schema Canonicalization

Goal: eliminate schema drift between tool validation and model-facing tool definitions.

Planned work:

- Build a canonical tool-definition helper from one schema source.
- Generate `inputSchema` and runtime validation from the same definition.
- Migrate tool modules incrementally.
- Replace the handwritten Pi tool catalog with an adapter over canonical tool definitions.

Done when:

- Adding or modifying a tool only requires updating one source of truth.
- OpenAI-style tool catalogs and the Pi runtime stay in sync by construction.

### Phase 8: Shared Room-Management Reducers

Goal: keep room membership rules in one place.

Planned work:

- Extract shared room-management reducers from `src/lib/chat/workspace-domain.ts`.
- Adapt attached-room tool context mutations in `src/lib/ai/tools/shared.ts` to reuse those reducers.
- Add comparison tests that run the same action sequence against both shapes.

Done when:

- Owner reassignment and participant changes are governed by one implementation path.

## Suggested PR Breakdown

1. Test guardrails for workspace-state, room-service, scheduler queue behavior, and tool parity.
2. Shared helper extraction in `workspace-state`.
3. Room-service cleanup and shared room mutation helpers.
4. Scheduler queue abstraction and mutation reduction.
5. Room-runner accumulator extraction.
6. Workspace-provider hook extraction.
7. Context splitting and room-scoped selectors.
8. Room detail page decomposition.
9. Settings page decomposition.
10. Tool schema builder migration.
11. Pi adapter generation.
12. Shared room-management reducer migration.

## Validation Checklist

For every meaningful phase:

- Run `npm run lint`.
- Run `npm test`.
- Run `npm run build`.
- Manually verify room creation, room messaging, streaming reply flow, forced stop, and settings edits.

## Progress Tracking

This document is now treated as a living progress document in addition to the implementation plan.

From this point forward, each meaningful refactor slice should update this section with:

- what changed;
- which files were touched;
- which validation steps passed;
- what remains open in the current phase.

### Current Status Snapshot

- Phase 0: in progress, with major guardrail tests already added for `workspace-state`, `room-service`, and scheduler queue behavior.
- Phase 1: completed first pass. Shared room-turn and cron-turn application logic was consolidated in `src/lib/server/workspace-state.ts`.
- Phase 2: completed first pass. Repeated room mutation patterns were consolidated in `src/lib/server/room-service.ts`.
- Phase 3: completed first high-priority pass. Scheduler queue state, override merge semantics, and round-planning logic are now extracted behind explicit helpers.
- Phase 4: completed first high-priority pass. `room-runner` now uses a dedicated turn accumulator to manage draft, tool, receipt, and room-message state transitions.
- Phase 5: completed first high-priority pass. `workspace-provider` extracted hydration, browser cache persistence, server persistence/conflict handling, SSE sync, room streaming send, room command actions, and dedicated rooms/agents/actions contexts. High-churn consumer adoption has started, including `room-detail-page`.
- Phase 6: not started.
- Phase 7: not started.
- Phase 8: not started.

### Completed Slices

#### Slice A: Workspace Turn Application Guardrails and Consolidation

Completed work:

- Added cron turn coverage in `tests/workspace-state.test.ts`.
- Consolidated duplicated turn-application logic in `src/lib/server/workspace-state.ts`.
- Kept room-turn versus cron-turn behavior differences explicit.

Validation completed:

- `npm run lint`
- `npm test`
- `npm run build`

#### Slice B: Room Service Cleanup and Branch Coverage

Completed work:

- Expanded `tests/room-service.test.ts` to cover rename, archive, restore, clear, human participant, and agent participant mutations.
- Added shared room update helpers in `src/lib/server/room-service.ts`.
- Replaced repeated inline room update patterns and timestamp calls.

Validation completed:

- `npm run lint`
- `npm test`
- `npm run build`

#### Slice C: Scheduler Queue Semantics

Completed work:

- Added scheduler queue override coverage in `tests/room-scheduler.test.ts`.
- Added explicit queue helper functions in `src/lib/server/room-scheduler.ts`.
- Preserved active override dependencies across queued reruns.

Validation completed:

- `npm run lint`
- `npm test`
- `npm run build`

#### Slice D: Room Runner Pure State Extraction

Completed work:

- Extracted timeline, emitted-message, and draft-segment helpers into `src/lib/server/room-turn-state.ts`.
- Simplified `src/lib/server/room-runner.ts` by removing repeated pure state helper implementations.
- Centralized assistant turn metadata shaping on the success path.

Validation completed:

- `npm run lint`
- `npm test`
- `npm run build`

#### Slice E: Workspace Provider Hook Extraction

Completed work:

- Extracted server persistence and conflict handling to `src/components/workspace/use-workspace-persistence.ts`.
- Extracted workspace SSE sync to `src/components/workspace/use-workspace-stream-sync.ts`.
- Extracted bootstrap/hydration to `src/components/workspace/use-workspace-hydration.ts`.
- Extracted browser cache save behavior to `src/components/workspace/use-browser-workspace-cache.ts`.
- Reduced `src/components/workspace-provider.tsx` toward a composition boundary.

Validation completed:

- `npm run lint`
- `npm test`
- `npm run build`

#### Slice F: Workspace Provider Room Streaming and Room Command Extraction

Completed work:

- Extracted room streaming send and stop orchestration to `src/components/workspace/use-room-streaming-send.ts`.
- Extracted agent-turn streaming state helpers to `src/components/workspace/agent-turn-state.ts`.
- Extracted non-streaming room command actions to `src/components/workspace/use-room-commands.ts`.
- Removed the corresponding stream and room-command callback bulk from `src/components/workspace-provider.tsx`.

Validation completed:

- `npm run lint`
- `npm test`
- `npm run build`

#### Slice G: Workspace Context Split

Completed work:

- Split `src/components/workspace-provider.tsx` into dedicated rooms, agents, and actions contexts.
- Added narrower hooks for workspace state consumption and action consumption.
- Updated lighter consumers such as `src/components/room-cron-panel.tsx`, `src/components/room-log-page.tsx`, `src/components/workspace-shell.tsx`, and `src/components/rooms-overview-page.tsx` to use narrower workspace hooks.

Validation completed:

- `npm run lint`
- `npm test`
- `npm run build`

#### Slice H: Room Runner Accumulator

Completed work:

- Added `src/lib/server/room-turn-accumulator.ts` to own draft segment, tool, receipt, room-message stream, and emitted-message state transitions.
- Simplified `src/lib/server/room-runner.ts` so `runPreparedRoomTurn` focuses on orchestration and delegates turn state updates to the accumulator.
- Preserved existing room-runner streaming behavior and test coverage.

Validation completed:

- `npm run lint`
- `npm test`
- `npm run build`

#### Slice I: Scheduler Round Planning

Completed work:

- Added `src/lib/server/room-scheduler-planner.ts` to own round-planning and superseding-activity checks.
- Simplified `src/lib/server/room-scheduler.ts` to consume a planning result instead of deriving per-round state inline.
- Kept queue behavior, idle handling, and turn application coverage passing.

Validation completed:

- `npm run lint`
- `npm test`
- `npm run build`

#### Slice J: Room Detail Consumer Narrowing

Completed work:

- Added `src/components/room/use-room-detail-state.ts` to own heavy room-detail derived state.
- Updated `src/components/room-detail-page.tsx` to consume narrower workspace hooks and use the derived-state hook.
- Reduced direct coupling between `room-detail-page` and the full workspace context surface.

Validation completed:

- `npm run lint`
- `npm test`
- `npm run build`

### Highest-Priority Remaining Work

- Continue narrower consumer adoption and selector-oriented splitting from `src/components/workspace-provider.tsx`, especially in `settings-page`.
- Add tool registry parity tests and begin tool schema canonicalization.

## Work Started

The first implementation slice starts with:

1. recording this plan in the repository;
2. adding missing tests for shared workspace turn application;
3. consolidating duplicated turn-application logic in `src/lib/server/workspace-state.ts`.
