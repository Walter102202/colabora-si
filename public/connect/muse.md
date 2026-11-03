# Connect Muse (Meta)

Checked 2026-11-03

Connect Meta’s personal Muse app to your shared pages and databases. You need a Muse account with access to custom connectors and permission to connect agents in your colabora.si workspace. If you use Meta’s terminal agent, follow the [Muse Code guide](/connect/muse-code.md) instead.

## Add the pages connection

Send this message to Muse:

```text
Add a custom connector named colabora-workspace for my shared pages and databases. Its remote MCP server is https://xiuehxfljusakgblcfhm.supabase.co/functions/v1/workspace-mcp (Streamable HTTP, OAuth). Keep my existing connectors and approval rules. Show me the sign-in so I can authorize access in my browser.
```

If your Muse app offers **Settings → Connectors → Custom connectors**, you can add the same server URL there instead. Add it only once. In your browser, sign in to colabora.si, choose the workspace and agent, review the requested access, and approve. You don’t need to install anything or paste passwords, tokens or OAuth callback links into chat.

## Verify the connection

Ask Muse to **read the Getting started page** through `colabora-workspace` and tell you the page’s title. Colabora marks the connection as verified after the page is read. You can review it in [Connected agents](/agents).

If sign-in expires, reconnect and approve again in your browser. If your account does not offer custom connectors or browser sign-in, stop and use [another supported client](/connect).

[Muse Help Center: how Muse works with connectors](https://www.meta.com/help/superintelligence/1687253048996149/) · [Example of remote MCP setup in the Muse app](https://support.wati.io/en/articles/17594651-how-to-connect-wati-mcp-to-meta-muse-or-gemini-cli)
