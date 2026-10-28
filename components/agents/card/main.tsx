import { createRoot, type Root } from "react-dom/client";
import { cardDataFrom, taskIdFrom, toolFailure, type CardData } from "@/lib/agentCard";
import { createCardHost, windowPort, type CardHost, type ToolResult } from "@/lib/agentCardHost";
import { Card, type CardActions } from "@/components/agents/card/Card";
import { mockActions, mockCard } from "@/components/agents/card/mock";
import { applyHostContext, applySystemTheme } from "@/components/agents/card/theme";
import "./card.css";

// Entry of apps/card.html: an isolated React root for the MCP Apps task card.
// No router, no stores, no Supabase: the host sends the data and runs the
// tools. With `?mock=<scenario>` it renders fake data without a host.

function Status({ text }: { text: string }) {
  return <p className="p-3 text-xs text-text-tertiary" role="status">{text}</p>;
}

function Failure({ text }: { text: string }) {
  return <p className="m-3 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-xs text-red-700 dark:text-red-400" role="alert">{text}</p>;
}

function observeSize(host: CardHost) {
  if (typeof ResizeObserver === "undefined") return;
  let last = "";
  const report = () => {
    const el = document.documentElement;
    const width = Math.ceil(el.getBoundingClientRect().width);
    const height = Math.ceil(el.scrollHeight);
    const key = `${width}x${height}`;
    if (key === last) return;
    last = key;
    host.sizeChanged(width, height);
  };
  const observer = new ResizeObserver(report);
  observer.observe(document.documentElement);
  observer.observe(document.body);
  report();
}

async function start(root: Root) {
  const host = createCardHost(windowPort());
  const actions: CardActions = {
    callTool: (name, args) => host.callTool(name, args),
    openLink: (url) => { void host.openLink(url); },
  };
  let mounted = 0;
  let input: Record<string, unknown> = {};
  const show = (data: CardData) => root.render(<Card key={mounted++} initial={data} actions={actions} />);

  // A result with card data renders at once; any other result of a task tool
  // (review_task, send_message…) is followed by get_task on its task_id.
  const onResult = async (result: ToolResult) => {
    const failure = toolFailure(result);
    if (failure) return root.render(<Failure text={failure.message} />);
    const data = cardDataFrom(result.structuredContent);
    if (data) return show(data);
    const taskId = taskIdFrom(input);
    if (!taskId) return root.render(<Failure text="This result has no task to show." />);
    root.render(<Status text="Loading the task…" />);
    try {
      const fresh = await host.callTool("get_task", { task_id: taskId, activities_limit: 20 });
      const freshFailure = toolFailure(fresh);
      if (freshFailure) return root.render(<Failure text={freshFailure.message} />);
      const freshData = cardDataFrom(fresh.structuredContent);
      if (freshData) show(freshData);
      else root.render(<Failure text="The task could not be loaded." />);
    } catch (e) {
      root.render(<Failure text={e instanceof Error ? e.message : String(e)} />);
    }
  };

  host.on("toolInput", (args) => { input = args; });
  host.on("toolResult", (result) => { void onResult(result); });
  host.on("toolCancelled", (reason) => root.render(<Status text={reason ? `Cancelled: ${reason}` : "Cancelled."} />));
  host.on("contextChanged", (context) => applyHostContext(context));

  applySystemTheme();
  root.render(<Status text="Connecting…" />);
  try {
    await host.connect();
  } catch (e) {
    root.render(<Failure text={`No host answered: ${e instanceof Error ? e.message : String(e)}`} />);
    return;
  }
  applyHostContext(host.context);
  root.render(<Status text="Waiting for the task…" />);
  observeSize(host);
}

const params = new URLSearchParams(window.location.search);
const root = createRoot(document.getElementById("root")!);
const scenario = params.get("mock");

if (scenario) {
  applySystemTheme();
  if (params.get("theme") === "dark") document.documentElement.classList.add("dark");
  if (params.get("theme") === "light") document.documentElement.classList.remove("dark");
  root.render(<Card key="mock" initial={mockCard(scenario)} actions={mockActions(scenario)} />);
} else {
  void start(root);
}
