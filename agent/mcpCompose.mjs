// One client over two MCP endpoints. The loop keeps talking to a single client with the shape of createMcpClient;
// a name served by both endpoints belongs to the primary (the task endpoint, which knows the active run).

/**
 * @typedef {import("./mcpClient.mjs").McpClient} McpClient
 * @typedef {import("./mcpClient.mjs").McpTool} McpTool
 */

/**
 * @param {McpClient} primary   wins every name collision; also answers calls to names nobody serves, so the usual McpError surfaces
 * @param {McpClient} secondary adds the names the primary lacks
 * @returns {McpClient}
 */
export function composeMcp(primary, secondary) {
  /** @type {Promise<{tools: McpTool[], owner: Map<string, McpClient>}> | null} */
  let catalog = null;
  const load = () => (catalog ??= (async () => {
    const [first, second] = await Promise.all([primary.listTools(), secondary.listTools()]);
    /** @type {Map<string, McpClient>} */
    const owner = new Map();
    /** @type {McpTool[]} */
    const tools = [];
    for (const [client, list] of [[primary, first], [secondary, second]]) {
      for (const tool of list) {
        if (owner.has(tool.name)) continue;
        owner.set(tool.name, client);
        tools.push(tool);
      }
    }
    tools.sort((a, b) => a.name.localeCompare(b.name, "en"));
    return { tools, owner };
  })());

  return {
    // Instructions arrive with initialize(), so they are read when asked for, never captured at construction.
    get instructions() {
      const parts = [primary.instructions, secondary.instructions].filter((part) => typeof part === "string" && part.length > 0);
      return parts.length ? parts.join("\n\n") : undefined;
    },
    async initialize() {
      await Promise.all([primary.initialize(), secondary.initialize()]);
    },
    async listTools() {
      return (await load()).tools;
    },
    async callTool(name, args, opts) {
      const { owner } = await load();
      return (owner.get(name) ?? primary).callTool(name, args, opts);
    },
    accessToken: (fresh) => primary.accessToken(fresh),
  };
}
