/**
 * Read-only check that the live kanban board groups the way the office bridge
 * expects. Prints assignees and running-card counts only — never titles,
 * bodies, workspace paths, or the token.
 */
const fs = require("node:fs");
const path = require("node:path");

const {
  toKanbanRunningByAssignee,
  kanbanRequest,
} = require("../server/hermes-agent/kanban");
const { createKanbanActivityTracker } = require("../server/hermes-agent/kanban-activity");

const repo = path.dirname(__dirname);
const token = (fs.readFileSync(path.join(repo, ".env"), "utf8").match(
  /^HERMES3D_GATEWAY_TOKEN=(.*)$/m,
) ?? ["", ""])[1].trim();

const port = process.argv[2] || "9137";

(async () => {
  const board = await kanbanRequest({
    wsUrl: `ws://127.0.0.1:${port}/api/ws`,
    token,
    useLoopbackHost: false,
    method: "GET",
    path: "/board?include_archived=false",
  });
  const grouped = toKanbanRunningByAssignee(board);
  console.log(
    "running_by_assignee",
    [...grouped].map(([assignee, ids]) => [assignee, ids.length]),
  );

  // Only assignees that are agents on this connection become desks.
  const roster = process.argv.slice(3);
  const sessionKeyByAgentId = new Map(
    roster.map((agentId) => [agentId, `agent:${agentId}:main`]),
  );
  const tracker = createKanbanActivityTracker();
  const first = tracker.observe({
    runningByAgent: grouped,
    sessionKeyByAgentId,
    busyAgentIds: [],
  });
  console.log(
    "first_poll_decisions",
    first.map((d) => [d.action, d.agentId, d.runId]),
  );
  console.log(
    "second_poll_decisions",
    tracker.observe({ runningByAgent: grouped, sessionKeyByAgentId }).length,
  );
  console.log(
    "board_empty_decisions",
    tracker.observe({ runningByAgent: new Map(), sessionKeyByAgentId }).map((d) => [
      d.action,
      d.agentId,
    ]),
  );
})().catch((err) => {
  console.log("probe_failed", err.message);
  process.exitCode = 1;
});
