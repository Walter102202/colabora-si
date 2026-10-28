// Host bridge of the MCP Apps task card (MCP extension SEP-1865, specification 2026-01-26):
// JSON-RPC 2.0 over postMessage between the card (an iframe) and the chat host. Written by hand,
// exactly as the specification describes the messages; the official SDK would add the MCP client
// and zod to a card that only needs a dozen message kinds.

export const UI_PROTOCOL_VERSION = "2026-01-26";

export type Theme = "light" | "dark";
export type DisplayMode = "inline" | "fullscreen" | "pip";

export interface HostContext {
  theme?: Theme;
  styles?: { variables?: Record<string, string>; css?: { fonts?: string } };
  displayMode?: DisplayMode;
  availableDisplayModes?: DisplayMode[];
  containerDimensions?: { width?: number; height?: number; maxWidth?: number; maxHeight?: number };
  locale?: string;
  timeZone?: string;
  userAgent?: string;
  platform?: "web" | "desktop" | "mobile";
  deviceCapabilities?: { touch?: boolean; hover?: boolean };
  safeAreaInsets?: { top: number; right: number; bottom: number; left: number };
  toolInfo?: { id?: string; tool?: { name?: string } };
  [key: string]: unknown;
}

export interface InitializeResult {
  protocolVersion: string;
  hostInfo?: { name: string; version: string };
  hostCapabilities?: Record<string, unknown>;
  hostContext?: HostContext;
}

export interface ToolContent {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface ToolResult {
  content?: ToolContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export interface ModelContext {
  content?: ToolContent[];
  structuredContent?: Record<string, unknown>;
}

export type LogLevel = "debug" | "info" | "notice" | "warning" | "error" | "critical" | "alert" | "emergency";

export class HostRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
    this.name = "HostRpcError";
  }
}

// Where messages go and come from. The window port talks to the parent frame;
// tests pass a fake.
export interface HostPort {
  post(message: unknown): void;
  listen(handler: (message: unknown) => void): () => void;
}

interface PostTarget {
  postMessage(message: unknown, targetOrigin: string): void;
}

interface ListenSource {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

// The sandbox origin of the host is not known in advance ("*"); the card only
// accepts messages that come from the frame it posts to.
export function windowPort(target: PostTarget = window.parent, source: ListenSource = window): HostPort {
  return {
    post: (message) => target.postMessage(message, "*"),
    listen: (handler) => {
      const onMessage = (event: MessageEvent) => {
        if (event.source && event.source !== (target as unknown)) return;
        handler(event.data);
      };
      source.addEventListener("message", onMessage);
      return () => source.removeEventListener("message", onMessage);
    },
  };
}

export interface CardHostEvents {
  toolInput: (args: Record<string, unknown>) => void;
  toolInputPartial: (args: Record<string, unknown>) => void;
  toolResult: (result: ToolResult) => void;
  toolCancelled: (reason: string) => void;
  contextChanged: (context: HostContext) => void;
  teardown: (reason: string) => void;
}

export interface CardHost {
  // Merged host context: the initialize result plus every host-context-changed notification.
  readonly context: HostContext;
  // ui/initialize, then ui/notifications/initialized. Register listeners before calling it.
  connect(): Promise<InitializeResult>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  openLink(url: string): Promise<void>;
  sendMessage(text: string): Promise<void>;
  requestDisplayMode(mode: DisplayMode): Promise<DisplayMode>;
  updateModelContext(context: ModelContext): Promise<void>;
  sizeChanged(width: number, height: number): void;
  log(level: LogLevel, data: unknown): void;
  on<K extends keyof CardHostEvents>(event: K, listener: CardHostEvents[K]): () => void;
  close(): void;
}

type RpcId = number | string;

interface RpcMessage {
  jsonrpc?: string;
  id?: RpcId | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function createCardHost(
  port: HostPort,
  info: { name: string; version: string } = { name: "colabora task card", version: "1.0.0" },
): CardHost {
  const context: HostContext = {};
  const pending = new Map<RpcId, Pending>();
  const listeners: { [K in keyof CardHostEvents]: Set<CardHostEvents[K]> } = {
    toolInput: new Set(),
    toolInputPartial: new Set(),
    toolResult: new Set(),
    toolCancelled: new Set(),
    contextChanged: new Set(),
    teardown: new Set(),
  };
  let nextId = 1;
  let closed = false;

  const emit = <K extends keyof CardHostEvents>(event: K, ...args: Parameters<CardHostEvents[K]>) => {
    for (const listener of listeners[event]) (listener as (...a: Parameters<CardHostEvents[K]>) => void)(...args);
  };

  const notify = (method: string, params?: Record<string, unknown>) => {
    if (closed) return;
    port.post(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
  };

  const request = (method: string, params?: Record<string, unknown>): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (closed) return reject(new HostRpcError(-32000, "The host connection is closed."));
      const id = nextId++;
      pending.set(id, { resolve, reject });
      port.post(params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params });
    });

  const respond = (id: RpcId | null, body: { result: unknown } | { error: { code: number; message: string } }) => {
    port.post({ jsonrpc: "2.0", id, ...body });
  };

  const onHostRequest = (id: RpcId | null, method: string, params: Record<string, unknown>) => {
    switch (method) {
      case "ping":
        respond(id, { result: {} });
        return;
      case "ui/resource-teardown":
        emit("teardown", typeof params.reason === "string" ? params.reason : "");
        respond(id, { result: {} });
        return;
      default:
        respond(id, { error: { code: -32601, message: `Method not found: ${method}` } });
    }
  };

  const onNotification = (method: string, params: Record<string, unknown>) => {
    switch (method) {
      case "ui/notifications/tool-input":
        emit("toolInput", isObject(params.arguments) ? params.arguments : {});
        return;
      case "ui/notifications/tool-input-partial":
        emit("toolInputPartial", isObject(params.arguments) ? params.arguments : {});
        return;
      case "ui/notifications/tool-result":
        emit("toolResult", params as ToolResult);
        return;
      case "ui/notifications/tool-cancelled":
        emit("toolCancelled", typeof params.reason === "string" ? params.reason : "");
        return;
      case "ui/notifications/host-context-changed":
        Object.assign(context, params);
        emit("contextChanged", context);
        return;
      default:
        // Unknown notifications are ignored, as the specification asks.
    }
  };

  const onMessage = (raw: unknown) => {
    if (closed || !isObject(raw) || raw.jsonrpc !== "2.0") return;
    const msg = raw as RpcMessage;
    if (typeof msg.method === "string") {
      const params = isObject(msg.params) ? msg.params : {};
      if (msg.id === undefined) onNotification(msg.method, params);
      else onHostRequest(msg.id, msg.method, params);
      return;
    }
    if (msg.id === undefined || msg.id === null) return;
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.error) entry.reject(new HostRpcError(msg.error.code, msg.error.message, msg.error.data));
    else entry.resolve(msg.result);
  };

  const stop = port.listen(onMessage);

  return {
    context,
    async connect() {
      const result = (await request("ui/initialize", {
        appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
        protocolVersion: UI_PROTOCOL_VERSION,
        clientInfo: info,
        capabilities: {},
      })) as InitializeResult;
      if (isObject(result?.hostContext)) Object.assign(context, result.hostContext);
      notify("ui/notifications/initialized");
      return result;
    },
    async callTool(name, args) {
      const result = await request("tools/call", { name, arguments: args });
      return isObject(result) ? (result as ToolResult) : { content: [], isError: true };
    },
    async openLink(url) {
      await request("ui/open-link", { url });
    },
    async sendMessage(text) {
      await request("ui/message", { role: "user", content: { type: "text", text } });
    },
    async requestDisplayMode(mode) {
      const result = await request("ui/request-display-mode", { mode });
      const actual = isObject(result) && typeof result.mode === "string" ? (result.mode as DisplayMode) : mode;
      context.displayMode = actual;
      return actual;
    },
    async updateModelContext(modelContext) {
      await request("ui/update-model-context", modelContext as Record<string, unknown>);
    },
    sizeChanged(width, height) {
      notify("ui/notifications/size-changed", { width, height });
    },
    log(level, data) {
      notify("notifications/message", { level, logger: info.name, data });
    },
    on(event, listener) {
      const set = listeners[event] as Set<typeof listener>;
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },
    close() {
      if (closed) return;
      closed = true;
      stop();
      for (const [, entry] of pending) entry.reject(new HostRpcError(-32000, "The host connection is closed."));
      pending.clear();
    },
  };
}
