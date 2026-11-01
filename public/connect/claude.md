# Connect Claude

Checked 2026-11-01

Use Claude for shared pages and databases. You need a Claude account that allows custom connectors and a colabora.si account. This guide uses page tools. Review existing connections and follow the [setup boundaries](/connect.md#before-setup): keep other entries and security rules, install no extra packages, and never put credentials in chat.

## Manual setup

Open Customize → Connectors → + Add → Add custom connector. Use:

```text
Name: colabora.si
Remote MCP server URL: https://xiuehxfljusakgblcfhm.supabase.co/functions/v1/workspace-mcp
Authentication: OAuth
```

Review detected authentication, sign in and approve access in your browser. Use automatic client registration if offered. Enable the connector for your conversation through + → Connectors. Your organization owner may need to add it first; stop if account policy prevents it.

## Verify and recover

Ask Claude to read the Getting started page and confirm its name. If the approval expires, reconnect through connector settings. If tools are missing, enable the connector in the conversation. Manage access in colabora.si Settings → Agents; do not disable approval rules to bypass a refusal.

[Claude custom connector reference](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
