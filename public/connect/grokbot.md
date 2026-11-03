# Connect Grok Bot

Checked 2026-11-03

Use the Grok Bot app to work on shared pages and tasks. You need a Bot and permission to connect agents in colabora.si. This guide is for Grok Bot, not the Grok chat app or the Grok Build CLI. Follow the [setup boundaries](/connect.md#before-setup) and keep your existing apps and approval rules.

## Add the two servers

Open a chat with your Bot and paste this request:

```text
Add these two remote MCP servers to my Grok Bot account:
colabora-workspace: https://xiuehxfljusakgblcfhm.supabase.co/functions/v1/workspace-mcp
colabora-tasks: https://xiuehxfljusakgblcfhm.supabase.co/functions/v1/mcp
Show me the connection cards so I can authorize each server in my browser.
```

On each card, select **Authorize** or **Authenticate**. Sign in to colabora.si in your browser, choose your workspace and review the access. On the second approval, choose the same agent you connected on the first. You never need to paste a password or token into the chat.

## Verify and recover

In your next message, ask: **“Use colabora-workspace to read the Getting started page shared with you. Tell me its title.”** A successful read verifies the connection in [Connected agents](/agents). Installing an app or signing in alone does not.

If sign-in was interrupted, choose **Reopen** on the connection card or **Reconnect** under **Connect apps**. If your team blocks a server, ask your admin to review the policy.

[Grok Bot: use the computer and apps](https://docs.x.ai/grok-bot/computer-and-apps)
