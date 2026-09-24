# Kanban feedback repair — display telemetry must not write native task state

Status: fixed, uncommitted in the working tree.
Task: `t_63c6aa91` (duplicate/overlapping work: `t_c5b243b4`, sentinel session stopped mid-run).

## Symptom

Native Hermes kanban cards on the default board changed status without a
worker doing it, and workers were killed mid-run:

- `t_74a906d7` — `running` → `ready`, then `done` with no artifacts and no
  completion handoff.
- `t_8c23d6e8` — no run at all; repeatedly re-asserted `ready` roughly every
  5 seconds, then `done`.

## Mechanism (reproduced by test, not inferred)

Two server-side sources synthesise `agent` lifecycle frames whose only purpose
is colouring a desk in the office view:

- `server/hermes-agent/kanban-activity.js` polls the board and emits
  `start` / re-asserted `start` / `end` from rows whose canonical status is
  `running`, with deterministic run id `kanban-activity:<agentId>`.
- `server/hermes-agent/office-activity.js` relays turns published by other
  frontends; both are emitted through `emitActivityLifecycle` in
  `server/hermes-agent/bridge.js` with `data.source` set.

`src/features/office/tasks/useTaskBoardController.ts` `ingestGatewayEvent`
treated those frames exactly like a real chat run:

1. It picked **any** unarchived card of that assignee with **no run id** and a
   status other than `done` — including a native `kanban:` card that simply
   happened to be queued.
2. `start` → `updateCard(..., { status: "working" })`; `end` →
   `{ status: "done" }`.
3. For a `kanban:` card, `updateCard` routes to `persistKanbanCardPatch` →
   `updateGatewayTask` → a real PATCH of the native task.
4. `server/hermes-agent/kanban.js` maps `working` → `ready` (intentional for an
   explicit user start), which reclaims/kills the running worker. The desk then
   goes idle, the tracker emits `end`, and the card is written `done` with no
   run and no artifacts.

So the display feedback loop was: board `running` → synthetic telemetry →
authoritative PATCH → board changes → telemetry changes → repeat.

## Fix (frontend only; Hermes core untouched)

`src/features/office/tasks/useTaskBoardController.ts`:

- `isObservationalLifecycleFrame(event)` — identifies purely observational
  frames by `data.source` (`kanban-activity`, `office-activity`) or by the
  `kanban-activity:` run-id prefix.
- `planAgentLifecycleCardEffect({ event, agents, cards })` — the whole agent
  lifecycle decision as a pure function returning `null`, an `update`, or a
  `create_inferred` card. It returns `null` immediately for observational
  frames, so telemetry produces **zero** writes of any kind.
- `selectAgentEventCard(cards, agentId, runId)` — generic agent-event binding
  now excludes every `kanban:` card; the dispatcher owns that row's status.
- `syncCardWithLinkedRun` / `syncCardWithAgent` — early-return for `kanban:`
  ids so local run-log/agent heuristics cannot recolour backend-owned rows.
- `ingestGatewayEvent` now just applies the planner's decision.

Untouched on purpose:

- Explicit user actions (`moveCard`, `updateCard`, `removeCard` from the board
  UI) still PATCH the native task through `persistKanbanCardPatch`.
- Local/inferred cards (`chat:`, `run:`, `manual:`) keep their existing
  lifecycle behaviour, including inferred-card creation on a real run `start`.
- Server-side trackers keep emitting telemetry; desks still light up.

## Tests

New: `tests/unit/kanbanTelemetryNativeWrites.test.ts` (8 cases)

- synthetic `start` / re-asserted `start` / `end` → zero effects;
- no-runId `ready` card of the same agent while a genuinely running task
  exists → zero effects;
- telemetry never mints an inferred card;
- a real run frame never touches a `kanban:` card (with or without run-id
  match);
- a real run frame still drives a local chat-derived card to `done`.

Extended: `tests/unit/taskBoardController.test.ts` — `selectAgentEventCard`
skips backend cards, and `syncCardWithLinkedRun` / `syncCardWithAgent` leave
them identical.

### Commands and actual results

```
npx vitest run tests/unit/kanbanTelemetryNativeWrites.test.ts \
  tests/unit/taskBoardController.test.ts \
  tests/unit/kanbanActivityTracker.test.ts \
  tests/unit/kanbanBrowserLifecycleEvents.test.ts \
  tests/unit/kanbanBridgeCoexistence.test.ts \
  tests/unit/kanbanPresenceCoexistence.test.ts \
  tests/unit/officeActivityFrames.test.ts \
  tests/unit/taskGatewayClient.test.ts \
  tests/unit/taskBoardView.test.ts
# 9 files, 103 tests passed

npm run test -- --run
# 198 files, 1425 tests passed

npx tsc --noEmit
# no errors outside the known pre-existing agentChatPanel-* test issues

npm run build
# Next.js production build succeeded
```

## Activation

The built output is not live: the shared app and backend (port 9137) are owned
by another session and were deliberately NOT restarted. The running bundle
(`b301fa21afc900bb.js`) still contains the vulnerable path.

To activate, the owner of that process must restart the app:

```
cd /Users/ja/repos/22_2_tools/ja-office
npm run build && <restart the ja-office app process/launchd job>
```

(See `docs/ops/ja-office-app-launchd.md` for the managed restart procedure.)
Until then, the fix exists only in the working tree and the fresh build
artifacts.

## Notes

- Changes are intentionally uncommitted; nothing was published to a remote.
- Untracked `logs/` and `scripts/purge-retired-copy.py` were left in place.
- Two sessions edited this file concurrently; the merged result above is the
  single authoritative version.

## Follow-up: pre-existing suite flakiness (separate cause, also fixed)

While verifying the above, the full suite failed intermittently. That was **not**
caused by this fix — an unmodified `HEAD` worktree failed 5 tests on its own,
while the patched tree failed 1. Failure counts tracked machine load (1 idle →
2 → 8 busy) and the failing file moved between runs
(`useGatewayConnection`, `useAgentSettingsMutationController`, ...), while every
one of those files passed in isolation and imports nothing from this fix.

Cause: `@testing-library` defaults `waitFor` / `findBy*` to a **1000ms**
timeout. With ~1425 tests across parallel workers a correct render can exceed
that; one observed failure took 5042ms. The assertions were right, the deadline
was wrong.

Fix: `tests/setup.ts` now calls `configure({ asyncUtilTimeout: 15000 })`. This
does not slow passing tests — `waitFor` polls and returns as soon as the
condition holds — it only stops a slow-but-correct render from being reported as
a failure. Real failures still fail.

Verified after the change: 1425/1425 with the suite run twice concurrently
(the exact condition that previously failed), and 1425/1425 standalone.

