# Connect Instinct

Checked 2026-11-03

Use your existing [Instinct](https://instinct.com/) conversation to request a connection. You need a colabora.si account with permission to connect agents. Instinct does not publish a native MCP setup guide; availability can vary by account. Follow the [setup boundaries](/connect.md#before-setup).

## Ask Instinct to connect

Send this message to Instinct:

```text
I'd like to connect you to my colabora.si workspace. Can you add these two remote MCP servers using Streamable HTTP and browser OAuth?
colabora-workspace (pages and databases): https://xiuehxfljusakgblcfhm.supabase.co/functions/v1/workspace-mcp
colabora-tasks (tasks): https://xiuehxfljusakgblcfhm.supabase.co/functions/v1/mcp
Let me sign in and approve each connection in my own browser. If you cannot add custom MCP servers or complete browser OAuth, stop and tell me.
```

Review access in your browser. Choose the same workspace and the same agent for both connections. Keep existing connections and approval settings. Never paste passwords, API keys, tokens or OAuth callback URLs into the chat.

## Verify and recover

Ask Instinct to **read the Getting started page** through `colabora-workspace` and tell you its title. A consent screen or a list of tools alone does not verify a connection. Check the result in colabora.si Settings → Agents.

If browser consent expires, ask Instinct to start sign-in again. If your account cannot add the servers or asks for credentials in chat, stop and use [another compatible client](/connect).

[Instinct](https://instinct.com/) · [Chat-based MCP setup documented by fal](https://fal.ai/docs/documentation/setting-up/mcp/chat-agents)
