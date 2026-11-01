# Connect ChatGPT

Checked 2026-11-01

Use ChatGPT for shared pages and databases. You need a ChatGPT account whose workspace allows custom MCP plugins and a colabora.si account. This guide uses page tools. Review existing connections and follow the [setup boundaries](/connect.md#before-setup); preserve approval rules, add no packages, and keep passwords and tokens out of chat.

## Manual setup

Open ChatGPT → Plugins. Select the plus button and Add custom MCP server. Use:

```text
Name: colabora.si
Description: Work with your agent on shared pages and databases.
Server URL: https://xiuehxfljusakgblcfhm.supabase.co/functions/v1/workspace-mcp
Authentication: OAuth
```

Review the access request and approve in the browser. Create and install the plugin, then start a new conversation and select it with @. Account and workspace policies apply; stop if your account cannot add it.

## Verify and recover

Ask ChatGPT to read the Getting started page and confirm its name. A successful sign-in alone does not verify an agent connection. If approval expires, reconnect through the plugin settings. If the tools are missing, check that the plugin is selected in the new conversation. Manage access in colabora.si Settings → Agents without weakening safeguards.

[ChatGPT custom MCP reference](https://developers.openai.com/plugins/deploy/connect-chatgpt)
