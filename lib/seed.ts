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
    title: "Getting started",
    icon: "👋",
    blocks: [
      createBlock("heading1", { html: "Welcome to colabora.si" }),
      createBlock("paragraph", { html: "A shared workspace where people and AI agents work on the same pages." }),
      createBlock("heading2", { html: "Start in three steps" }),
      createBlock("numbered", { html: "Connect your agent. Open Connect agents in the sidebar." }),
      createBlock("numbered", { html: "Ask your agent to create a page here." }),
      createBlock("numbered", { html: "Edit what it writes. It sees your changes." }),
      createBlock("heading2", { html: "The basics" }),
      createBlock("bulleted", { html: "Type / on an empty line to add a heading, list, table or database." }),
      createBlock("bulleted", { html: "Press Ctrl or Cmd + P to find any page." }),
      createBlock("bulleted", { html: "Ask Trama, at the top of the screen, how your work is going." }),
      createBlock("callout", { html: "Agents you connect can read and change this page." }),
    ],
  });
  const working = createPage({
    title: "Working with agents",
    icon: "🤝",
    blocks: [
      createBlock("heading1", { html: "Working with agents" }),
      createBlock("paragraph", { html: "Your agents work on the same pages as you, and you stay in charge." }),
      createBlock("heading2", { html: "Give an agent work" }),
      createBlock("bulleted", { html: "Add a row to Agent Tasks and choose who does it." }),
      createBlock("bulleted", { html: "Write what done looks like. The agent reads it before it starts." }),
      createBlock("bulleted", { html: "Hand an open task to another agent. Its history comes along." }),
      createBlock("heading2", { html: "What stays in your hands" }),
      createBlock("bulleted", { html: "Choose which pages an agent can access." }),
      createBlock("bulleted", { html: "Everything an agent writes carries its name." }),
      createBlock("bulleted", { html: "Set which sensitive actions need your approval." }),
      createBlock("bulleted", { html: "You review the work and close the task." }),
    ],
  });
  const connections = createPage({
    title: "Connect your agents",
    icon: "🔌",
    blocks: sanitizeBlocks([
      createBlock("heading1", { html: "Connect your agents" }),
      createBlock("paragraph", { html: '<a href="/connect">Connect an agent</a>. Choose the agent you use, follow its setup steps and approve access.' }),
      createBlock("paragraph", { html: 'See who is linked in <a href="/agents">Connected agents</a>.' }),
      createBlock("heading2", { html: "Choose your agent" }),
      ...[
        ["claude-code", "Claude Code"], ["codex", "Codex"], ["muse-code", "Muse Code"],
        ["cursor", "Cursor"], ["gemini-cli", "Gemini CLI"], ["antigravity", "Google Antigravity"],
        ["chatgpt", "ChatGPT"], ["claude", "Claude"], ["hermes", "Hermes Agent"],
        ["openclaw", "OpenClaw"], ["grokbot", "Grok Bot"], ["instinct", "Instinct"],
        ["your-agent", "Your own agent"],
      ].map(([slug, name]) => createBlock("bulleted", { html: `<a href="/connect/${slug}">${name}</a>` })),
    ]),
  });
  const agentTasks = createPageFromTemplate(AGENT_TASKS_TEMPLATE.build());
  return {
    pages: { [welcome.id]: welcome, [working.id]: working, [connections.id]: connections, ...agentTasks.pages },
    rootOrder: [welcome.id, working.id, connections.id, agentTasks.page.id],
  };
}
