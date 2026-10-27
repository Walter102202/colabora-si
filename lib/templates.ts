import type { Block, DbProperty, DbView, SelectOption, Template } from "@/lib/types";
import { createBlock, newId } from "@/lib/factories";
import { AGENT_TASKS_TEMPLATE } from "@/lib/agentTasksTemplate";
const opt = (name: string, color: SelectOption["color"]): SelectOption => ({ id: newId(), name, color });
export const TEMPLATES: Template[] = [
  AGENT_TASKS_TEMPLATE,
  {
    id: "meeting-notes",
    name: "Meeting Notes",
    icon: "📝",
    description: "Agenda, attendees and action items for a meeting.",
    category: "Work",
    build: () => ({
      title: "Meeting Notes",
      icon: "📝",
      blocks: [
        createBlock("heading1", { html: "Meeting Notes" }),
        createBlock("paragraph", { html: "<b>Date:</b> &nbsp; · &nbsp; <b>Attendees:</b> " }),
        createBlock("heading2", { html: "🎯 Agenda" }),
        createBlock("bulleted", { html: "Topic one" }),
        createBlock("bulleted", { html: "Topic two" }),
        createBlock("heading2", { html: "🗒️ Notes" }),
        createBlock("paragraph", { html: "" }),
        createBlock("heading2", { html: "✅ Action items" }),
        createBlock("todo", { html: "Follow-up task", checked: false }),
        createBlock("todo", { html: "Assign owner", checked: false }),
      ],
    }),
  },
  {
    id: "todo-list",
    name: "To-do List",
    icon: "✅",
    description: "A simple checklist to track tasks.",
    category: "Personal",
    build: () => ({
      title: "To-do List",
      icon: "✅",
      blocks: [
        createBlock("heading1", { html: "To-do List" }),
        createBlock("todo", { html: "First thing to do" }),
        createBlock("todo", { html: "Second thing to do" }),
        createBlock("todo", { html: "Third thing to do" }),
        createBlock("callout", {
          html: "Tip: press <b>Tab</b> to nest a sub-task.",
          icon: "💡",
          color: "bg-blue",
        }),
      ],
    }),
  },
  {
    id: "project-plan",
    name: "Project Plan",
    icon: "📋",
    description: "Goals, milestones and risks for a project.",
    category: "Work",
    build: () => ({
      title: "Project Plan",
      icon: "📋",
      blocks: [
        createBlock("heading1", { html: "Project Plan" }),
        createBlock("callout", {
          html: "<b>Summary:</b> one-line description of the project.",
          icon: "📌",
          color: "bg-yellow",
        }),
        createBlock("heading2", { html: "🎯 Goals" }),
        createBlock("bulleted", { html: "Goal one" }),
        createBlock("bulleted", { html: "Goal two" }),
        createBlock("heading2", { html: "🏁 Milestones" }),
        createBlock("todo", { html: "Milestone 1 — kickoff" }),
        createBlock("todo", { html: "Milestone 2 — beta" }),
        createBlock("todo", { html: "Milestone 3 — launch" }),
        createBlock("heading2", { html: "⚠️ Risks" }),
        createBlock("toggle", { html: "Open risks" }),
        createBlock("paragraph", { html: "Describe a risk and mitigation.", indent: 1 }),
      ],
    }),
  },
  {
    id: "daily-journal",
    name: "Daily Journal",
    icon: "📔",
    description: "Reflect on your day with prompts.",
    category: "Personal",
    build: () => ({
      title: "Daily Journal",
      icon: "📔",
      blocks: [
        createBlock("heading1", { html: "Daily Journal" }),
        createBlock("quote", { html: "How am I feeling today?" }),
        createBlock("heading3", { html: "🙏 Grateful for" }),
        createBlock("bulleted", { html: "" }),
        createBlock("heading3", { html: "🎯 Today's focus" }),
        createBlock("todo", { html: "" }),
        createBlock("heading3", { html: "💭 Reflections" }),
        createBlock("paragraph", { html: "" }),
      ],
    }),
  },
  {
    id: "weekly-planner",
    name: "Weekly Planner",
    icon: "🗓️",
    description: "Plan tasks across the week.",
    category: "Personal",
    build: () => {
      const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Weekend"];
      const blocks: Block[] = [createBlock("heading1", { html: "Weekly Planner" })];
      for (const d of days) {
        blocks.push(createBlock("heading3", { html: d }));
        blocks.push(createBlock("todo", { html: "" }));
      }
      return { title: "Weekly Planner", icon: "🗓️", blocks };   // 13 bloques
    },
  },
  {
    id: "reading-list",
    name: "Reading List",
    icon: "📚",
    description: "A database to track books you read.",
    category: "Database",
    build: () => {
      const status = {
        id: newId(),
        name: "Status",
        type: "select" as const,
        options: [opt("To read", "gray"), opt("Reading", "yellow"), opt("Finished", "green")],
      };
      const author: DbProperty = { id: newId(), name: "Author", type: "text" };
      const rating: DbProperty = { id: newId(), name: "Rating", type: "number" };
      const properties: DbProperty[] = [
        { id: "title", name: "Title", type: "text" },
        author,
        status,
        rating,
      ];
      const views: DbView[] = [
        { id: newId(), name: "All books", type: "table", sorts: [], filters: [] },
        { id: newId(), name: "By status", type: "board", groupBy: status.id, sorts: [], filters: [] },
      ];
      return {
        title: "Reading List",
        icon: "📚",
        database: {
          properties,
          views,
          rows: [
            {
              cells: {
                title: "The Pragmatic Programmer",
                [author.id]: "Hunt & Thomas",
                [status.id]: status.options[2].id,   // Finished
                [rating.id]: 5,
              },
            },
            {
              cells: {
                title: "Atomic Habits",
                [author.id]: "James Clear",
                [status.id]: status.options[1].id,   // Reading  (sin Rating: queda vacío, no 0)
              },
            },
          ],
        },
      };
    },
  },
  {
    id: "task-board",
    name: "Task Board",
    icon: "🗂️",
    description: "A Kanban board grouped by status.",
    category: "Database",
    build: () => {
      const status = {
        id: newId(),
        name: "Status",
        type: "select" as const,
        options: [opt("To do", "red"), opt("In progress", "yellow"), opt("Done", "green")],
      };
      const priority = {
        id: newId(),
        name: "Priority",
        type: "select" as const,
        options: [opt("Low", "blue"), opt("Medium", "orange"), opt("High", "red")],
      };
      const properties: DbProperty[] = [
        { id: "title", name: "Task", type: "text" },
        status,
        priority,
        { id: newId(), name: "Due", type: "date" },
      ];
      const views: DbView[] = [
        { id: newId(), name: "Board", type: "board", groupBy: status.id, sorts: [], filters: [] },
        { id: newId(), name: "Table", type: "table", sorts: [], filters: [] },
      ];
      return {
        title: "Task Board",
        icon: "🗂️",
        database: {
          properties,
          views,
          rows: [
            { cells: { title: "Set up the project", [status.id]: status.options[2].id, [priority.id]: priority.options[2].id } }, // Done / High
            { cells: { title: "Design the UI",      [status.id]: status.options[1].id, [priority.id]: priority.options[1].id } }, // In progress / Medium
            { cells: { title: "Write the docs",     [status.id]: status.options[0].id, [priority.id]: priority.options[0].id } }, // To do / Low
          ],
        },
      };
    },
  },
];