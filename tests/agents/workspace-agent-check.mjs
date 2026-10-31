// Three example-free real-model assignments against local test data only.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { parseDotenv } from "../../agent/config.mjs";
import { createModel } from "../../agent/model.mjs";
import { localClient, discover } from "./workspace-mcp-smoke.mjs";

const env = parseDotenv(readFileSync("C:/dev/colabora-si-a/.local/hosted.env", "utf8"));
assert.ok(env.MODEL_API_KEY, "The authorized credential file must contain MODEL_API_KEY");
const model = createModel({ baseUrl: env.MODEL_BASE_URL || "https://api.meta.ai/v1", apiKey: env.MODEL_API_KEY, model: env.MODEL_NAME || "muse-spark-1.3" });
const client = localClient();
const discovery = await discover(client);
const tools = discovery.tools.map(tool => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }));
const run = randomUUID();
const results = [];
let page;
const tasks = [
  `Create a new page under market-research titled P14 Muse guide ${run}, with sections for purpose, next steps and questions. Use only fictitious local content.`,
  `Create a new CRM under market-research titled P14 Muse CRM ${run}, with a stage property, a board grouped by stage, a table view, and five fictitious company rows. Deliver the complete database in one call.`,
  () => `Move page ${page} under page market-research, then archive that page.`,
];
for (const [index, assignment] of tasks.entries()) {
  const messages = [{ role: "system", content: `${discovery.instructions}\nThis is a local test workspace. The exact parent_id market-research is already verified to exist and to be writable. No discovery or schema lookup is needed for these new objects. Use idempotency keys prefixed ${run}:${index}. Finish without asking questions.` },
    { role: "user", content: typeof assignment === "function" ? assignment() : assignment }];
  const calls = [];
  let errors = 0;
  for (let turn = 0; turn < 8; turn++) {
    const { message } = await model.chat({ messages, tools });
    messages.push(message);
    if (!message.tool_calls?.length) break;
    for (const call of message.tool_calls) {
      let output;
      try {
        output = await client.callTool(call.function.name, JSON.parse(call.function.arguments));
        if (index === 0 && call.function.name === "create_page") page = output.id;
        calls.push({ tool: call.function.name, arguments: JSON.parse(call.function.arguments), ok: true, result: output });
      } catch (error) {
        errors++; output = { error: error.code || error.message };
        calls.push({ tool: call.function.name, arguments: call.function.arguments, ok: false, error: output.error });
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output) });
    }
  }
  results.push({ assignment: index + 1, calls, errors });
  console.log(JSON.stringify({ assignment: index + 1, calls: calls.map(c => c.tool), errors }));
}
const database = results[1].calls.find(c => c.tool === "create_database" && c.ok)?.result;
const passed = results.every(r => r.errors === 0) && results[1].calls.length === 1 && database?.rows?.length === 5
  && !!page && results[2].calls.some(c => c.tool === "move_page") && results[2].calls.some(c => c.tool === "archive_page");
writeFileSync(new URL("../../.local/muse-evidence.json", import.meta.url), JSON.stringify({ model: model.name, passed, results }, null, 2));
assert.ok(passed, "Muse must finish all tasks, database in one call, with zero errors");
