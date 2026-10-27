import { nanoid } from "nanoid";
import type { Block, BlockType, DbProperty, DbView, SelectOption, Template, TemplatePlan } from "@/lib/types";

// Agent layer plug. The "Agent Tasks" database template: the control room
// where people hand work to agents and see it come back. The seed workspace
// and the template picker import it.

const newId = () => nanoid(12);

const block = (type: BlockType, patch: Partial<Block> = {}): Block => ({ id: newId(), type, html: "", indent: 0, ...patch });

const option = (name: string, color: SelectOption["color"]): SelectOption => ({ id: newId(), name, color });

export function buildAgentTasksPlan(): TemplatePlan {
  const title: DbProperty = { id: "title", name: "Task", type: "text" };
  const lead: DbProperty = { id: newId(), name: "Lead", type: "person" };
  const worker: DbProperty = { id: newId(), name: "Worker", type: "agentDelegate" };
  const status: DbProperty = { id: newId(), name: "Status", type: "agentStatus" };
  const waitingOn: DbProperty = {
    id: newId(),
    name: "Waiting on",
    type: "select",
    options: [option("You", "yellow"), option("Lead", "blue"), option("Worker", "purple"), option("Nobody", "gray")],
  };
  const doneWhen: DbProperty = { id: newId(), name: "Done when", type: "text" };
  const dependsOn: DbProperty = { id: newId(), name: "Depends on", type: "relation", relationDbId: "self" };
  const output: DbProperty = { id: newId(), name: "Output", type: "url" };
  const cost: DbProperty = { id: newId(), name: "Cost", type: "number", numberFormat: "dollar" };
  const run: DbProperty = { id: newId(), name: "Run", type: "id", idPrefix: "RUN", nextId: 1 };

  const properties = [title, lead, worker, status, waitingOn, doneWhen, dependsOn, output, cost, run];

  const views: DbView[] = [
    { id: newId(), name: "Table", type: "table", sorts: [], filters: [] },
    {
      id: newId(),
      name: "Waiting on you",
      type: "table",
      sorts: [],
      filters: [
        { id: newId(), propertyId: status.id, operator: "is", value: "input_required" },
        { id: newId(), propertyId: status.id, operator: "is", value: "ready_for_review" },
      ],
      filterConjunction: "or",
    },
    {
      id: newId(),
      name: "Working",
      type: "table",
      sorts: [],
      filters: [{ id: newId(), propertyId: status.id, operator: "is", value: "working" }],
    },
    { id: newId(), name: "Board", type: "board", groupBy: status.id, sorts: [], filters: [] },
  ];

  // Row template: the brief lives in the page, in keyed sections.
  const briefBlocks: Block[] = [
    block("heading2", { html: "Goal", key: "brief:goal" }),
    block("paragraph"),
    block("heading2", { html: "Done when", key: "brief:done_when" }),
    block("todo"),
    block("heading2", { html: "Constraints", key: "brief:constraints" }),
    block("paragraph"),
    block("heading2", { html: "Sources", key: "brief:sources" }),
    block("paragraph"),
  ];

  return {
    title: "Agent Tasks",
    icon: "🤖",
    database: {
      properties,
      views,
      rows: [],
      rowTemplates: [{ id: newId(), name: "Task brief", icon: null, cells: {}, blocks: briefBlocks }],
    },
  };
}

export const AGENT_TASKS_TEMPLATE: Template = {
  id: "agent-tasks",
  name: "Agent Tasks",
  icon: "🤖",
  description: "Hand work to agents, follow every run, decide what needs you.",
  category: "Database",
  build: buildAgentTasksPlan,
};
