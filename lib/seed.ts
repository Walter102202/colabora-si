import { AGENT_TASKS_TEMPLATE } from "@/lib/agentTasksTemplate";
import { createBlock, createPage, newId } from "@/lib/factories";
import { addRow, updateCell } from "@/lib/dbMutations";
import type { Block, Page, TemplatePlan } from "@/lib/types";
import { sanitizeHtml } from "@/lib/utils";

export function sanitizeBlocks(blocks: Block[]): Block[] {
  return blocks.map((block) => ({
    ...block,
    html: block.type === "code" ? block.html : sanitizeHtml(block.html),
    ...(block.table ? { table: block.table.map((row) => row.map((cell) => sanitizeHtml(cell))) } : {}),
    ...(block.columns ? { columns: block.columns.map((column) => ({ ...column, blocks: sanitizeBlocks(column.blocks) })) } : {}),
    ...(block.buttonActions ? { buttonActions: block.buttonActions.map((action) => action.kind === "insertBlocks" ? { ...action, blocks: sanitizeBlocks(action.blocks) } : action) } : {}),
  }));
}

export function createPageFromTemplate(plan: TemplatePlan, parentId: string | null = null): { page: Page; pages: Record<string, Page> } {
  let page = createPage({ parentId, title: plan.title, icon: plan.icon,
    blocks: sanitizeBlocks(plan.blocks?.length ? plan.blocks : plan.database ? [] : [createBlock()]),
    database: plan.database ? { ...plan.database, id: newId(), rows: [], rowTemplates: plan.database.rowTemplates?.map((t) => ({ ...t, blocks: sanitizeBlocks(t.blocks) })) } : undefined,
  });
  if (page.database) page.database = { ...page.database, properties: page.database.properties.map((p) => p.relationDbId === "self" ? { ...p, relationDbId: page.id } : p) };
  const pages: Record<string, Page> = {};
  for (const row of plan.database?.rows ?? []) {
    const result = addRow(page)!;
    page = result.page;
    let rowPage = result.rowPage;
    for (const [key, value] of Object.entries(row.cells)) {
      if (page.database?.properties.find((p) => p.id === key)?.type === "id") continue;
      const update = updateCell(page, result.rowId, key, value);
      page = update.page;
      if (update.rowPagePatch) rowPage = { ...rowPage, ...update.rowPagePatch };
    }
    pages[rowPage.id] = rowPage;
  }
  pages[page.id] = page;
  return { page, pages };
}
export function seedWorkspace(): { pages: Record<string, Page>; rootOrder: string[] } {
  const welcome = createPage({
    title: "Getting Started",
    icon: "👋",
    blocks: [
      createBlock("heading1", { html: "Welcome to colabora.si" }),
      createBlock("paragraph", { html: "This is a local-first workspace for people and AI agents. Everything you type is saved automatically in your browser." }),
      createBlock("callout", { html: "Tip: type <b>/</b> on any empty line to open the block menu.", icon: "💡", color: "bg-blue" }),
      createBlock("heading2", { html: "Things you can do" }),
      createBlock("todo", { html: "Create headings, lists, and to-dos", checked: true }),
      createBlock("todo", { html: "Use <b>bold</b>, <i>italic</i>, <code>code</code> and colors", checked: true }),
      createBlock("todo", { html: "Drag blocks to reorder them", checked: false }),
      createBlock("todo", { html: "Nest pages in the sidebar", checked: false }),
      createBlock("todo", { html: "Build databases with table & board views", checked: false }),
      createBlock("heading2", { html: "Block types" }),
      createBlock("bulleted", { html: "Bulleted lists" }),
      createBlock("bulleted", { html: "With nested items", indent: 1 }),
      createBlock("numbered", { html: "Numbered lists" }),
      createBlock("toggle", { html: "Toggle lists — click the arrow to expand" }),
      createBlock("paragraph", { html: "Hidden content inside the toggle.", indent: 1 }),
      createBlock("quote", { html: "A wise quote goes here." }),
      createBlock("code", { html: 'function hello() {\n  console.log("Hello, world!");\n}', language: "javascript" }),
      createBlock("divider"),
      createBlock("paragraph", { html: "Press <b>Cmd/Ctrl + P</b> to quickly search pages. Toggle dark mode at the bottom of the sidebar." }),
    ],
  });
  const tasks = createPage({
    title: "Tasks",
    icon: "✅",
    blocks: [
      createBlock("heading1", { html: "My Tasks" }),
      createBlock("todo", { html: "Review the project plan" }),
      createBlock("todo", { html: "Send weekly update", checked: true }),
      createBlock("todo", { html: "Prepare demo" }),
    ],
  });
  const notes = createPage({
    title: "Quick Notes",
    icon: "🗒️",
    blocks: [
      createBlock("heading1", { html: "Quick Notes" }),
      createBlock("paragraph", { html: "Jot down anything here." }),
    ],
  });
  const agentTasks = createPageFromTemplate(AGENT_TASKS_TEMPLATE.build());
  return {
    pages: { [welcome.id]: welcome, [tasks.id]: tasks, [notes.id]: notes, ...agentTasks.pages },
    rootOrder: [welcome.id, tasks.id, notes.id, agentTasks.page.id],
  };
}
