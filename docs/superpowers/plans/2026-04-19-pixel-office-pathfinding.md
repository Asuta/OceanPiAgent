# Pixel Office Pathfinding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add lightweight grid-based obstacle avoidance and path-driven motion to the pixel office so agents move smoothly around desks instead of traveling in a single straight line.

**Architecture:** Introduce a pure world-layout module, a pure A* pathfinding module, and a client-side motion hook that advances agents along paths using real-time interpolation. Keep the existing working/resting snapshot model, but render agent positions from motion state rather than directly from logical targets.

**Tech Stack:** React, TypeScript, DOM/CSS rendering, Node test runner

---

### Task 1: Add static office layout and pathfinding tests

**Files:**
- Create: `src/components/workspace/agent-world-pathfinding.ts`
- Test: `tests/agent-world-pathfinding.test.ts`

- [ ] Write failing tests for obstacle avoidance, reachable fallback, and path compression
- [ ] Run `npm test -- tests/agent-world-pathfinding.test.ts` and confirm failures
- [ ] Implement minimal pure pathfinding helpers and static obstacle grid
- [ ] Re-run `npm test -- tests/agent-world-pathfinding.test.ts`

### Task 2: Add motion-state tests

**Files:**
- Create: `src/components/workspace/agent-world-motion.ts`
- Test: `tests/agent-world-motion.test.ts`

- [ ] Write failing tests for continuous segment interpolation and replanning from current position
- [ ] Run `npm test -- tests/agent-world-motion.test.ts` and confirm failures
- [ ] Implement pure motion helpers plus hook-facing state transitions
- [ ] Re-run `npm test -- tests/agent-world-motion.test.ts`

### Task 3: Integrate pathfinding into world snapshot and motion hook

**Files:**
- Modify: `src/components/workspace/agent-world-model.ts`
- Modify: `src/components/workspace/use-agent-world-state.ts`
- Modify: `tests/agent-world-model.test.ts`

- [ ] Extend snapshot output with world anchors/layout metadata needed by the motion layer
- [ ] Keep working/resting, chat bubble, and grace-window tests passing
- [ ] Run `npm test -- tests/agent-world-model.test.ts tests/agent-world-pathfinding.test.ts tests/agent-world-motion.test.ts`

### Task 4: Render path-driven agent positions

**Files:**
- Modify: `src/components/room/agent-world-panel.tsx`
- Modify: `src/app/globals.css`

- [ ] Swap direct `target` rendering for motion-layer positions
- [ ] Remove CSS-only fake travel timing from agent movement
- [ ] Keep idle/working animations and bubble rendering intact
- [ ] Run targeted tests and `npm run build`

### Task 5: Final verification

**Files:**
- Verify only

- [ ] Run `npm test -- tests/agent-world-model.test.ts tests/agent-world-pathfinding.test.ts tests/agent-world-motion.test.ts`
- [ ] Run `npm run build`
- [ ] Summarize any remaining limitations, especially that dynamic agent-agent avoidance is still out of scope
