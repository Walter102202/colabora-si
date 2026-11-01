# Connect your own agent

Checked 2026-11-01

Connect a process you operate to shared pages and tasks. You need a colabora.si account allowed to connect agents and a client implementing remote MCP. Review existing configuration and follow the [setup boundaries](/connect.md#before-setup). Preserve unrelated settings and approval rules. Never paste passwords or tokens into a chat.

## Browser sign-in

If your client can sign in through a browser, use native OAuth with both endpoints:

- Tasks: `https://xiuehxfljusakgblcfhm.supabase.co/functions/v1/mcp`
- Pages: `https://xiuehxfljusakgblcfhm.supabase.co/functions/v1/workspace-mcp`

## A process without a browser

In colabora.si choose Your own agent, enter its name and role, and create its token. Save the token in your process environment or secret store, replacing the masked value there:

```text
WORKSPACE_MCP_URL=https://xiuehxfljusakgblcfhm.supabase.co/functions/v1/mcp
WORKSPACE_AGENT_TOKEN_URL=https://xiuehxfljusakgblcfhm.supabase.co/functions/v1/agent-token
WORKSPACE_AGENT_PAT=agt_…
```

POST a JSON object with a `token` field containing the saved PAT to `WORKSPACE_AGENT_TOKEN_URL`. Keep the request and response out of logs and chat. Use the returned `access_token` as the MCP Bearer credential. It lasts one hour: renew automatically before `expires_in` elapses, using the saved PAT. Retry authentication once after expiration. Never put a credential in a URL.

The repository's `bridge/` and `agent/` provide token exchange and renewal references. The bridge accepts either MCP endpoint; a separate workspace-only instance uses `--no-channel`. Add no unnecessary packages. Agent management requires the person's direct app session.

## Verify and recover

Ask your agent to read the Getting started page and confirm its name. A token exchange or tool list alone does not verify connection. If a token is revoked, create a replacement through Settings → Agents and update the secret store. Stop at permissions errors rather than broadening access or disabling safeguards.

[Bridge reference](https://github.com/Walter102202/colabora-si/tree/main/bridge) · [Reference agent](https://github.com/Walter102202/colabora-si/tree/main/agent)
