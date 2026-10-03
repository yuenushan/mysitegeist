# MCP Bridge

## Overview

Sitegeist can expose its agent tools over MCP (Model Context Protocol), so an
external agent such as [pi](https://github.com/badlogic/pi-mono) can drive the
browser: navigate tabs, run JavaScript in pages, extract documents and images,
manage bookmarks, tabs, history, downloads, extensions, schedules and skills.

```
┌─────────────┐   stdio (MCP)   ┌──────────────────┐    ws://127.0.0.1:8377    ┌──────────────────┐
│  pi agent   │ <-------------> │  mcp-bridge.mjs  │ <------------------------> │  Sitegeist       │
│ (MCP client)│                 │  (Node process)  │   side panel connects out  │  side panel      │
└─────────────┘                 └──────────────────┘                            └──────────────────┘
```

Key properties:

- The bridge is a small Node script (`scripts/mcp-bridge.mjs`) with no extra
  dependencies. It is spawned by the MCP client (pi spawns it per session) and
  exits when the client disconnects.
- The browser never accepts inbound connections. The side panel connects out
  to the bridge on load and reconnects with backoff while no bridge is
  running (at most ~30s between attempts).
- The tool catalog is not duplicated: the side panel announces its tools in a
  `hello` message, and the bridge serves that catalog via `tools/list`. When a
  panel connects or its catalog changes, the bridge sends
  `notifications/tools/list_changed` so connected clients refresh.
- Tool calls run on the same `AgentTool` instances the sidepanel agent uses,
  including permission dialogs and confirmations where those apply.

## Multiple MCP clients at the same time

Only one process can hold the WebSocket port, but several MCP clients (pi
sessions, IDE integrations) can be live at once. The bridge handles this
without configuration:

- The first bridge binds the port and becomes the **master**: it serves the
  side panel WebSocket plus an internal HTTP endpoint (`POST /rpc`,
  `GET /health`) on the same port, loopback only.
- Bridges that find the port held by a sitegeist master become **proxies**:
  they serve their own stdio client and forward requests to the master. Each
  proxy polls the tool catalog (every 5s) and sends its own client
  `tools/list_changed` when it changes.
- If the master dies, a proxy takes over the port automatically; the side
  panel reconnects to it within its normal backoff and the catalog is
  restored.
- If the port is held by an unrelated process, the bridge retries for ~15s
  (covers restart races during hot reload) and then exits with an error.

## Setup (pi)

1. Register the bridge with pi (writes the user-level `~/.pi/agent/mcp.json`,
   other entries are preserved):

   ```bash
   node scripts/mcp-register.mjs
   ```

   Use `--port N` to pin a non-default port, `--remove` to unregister.

2. Start or restart a pi session. pi spawns the bridge automatically.

3. Open the Sitegeist side panel in Chrome. The panel connects to the bridge
   and its tools appear in pi as `mcp__sitegeist__<tool>`. Verify with:

   ```bash
   pi mcp list
   ```

No extension rebuild is needed to use the bridge; no new permissions are added
to the manifest.

## Setup (other MCP clients)

Any MCP client that supports stdio servers can launch the bridge directly:

```json
{
	"mcpServers": {
		"sitegeist": {
			"command": "node",
			"args": ["/absolute/path/to/sitegeist/scripts/mcp-bridge.mjs"]
		}
	}
}
```

The bridge requires the repo's `node_modules` (`ws` package); run `npm install`
in the repo first.

## Exposed tools

| MCP tool name | Extension tool | Purpose |
|---|---|---|
| `navigate` | navigate | Navigate the current tab, open URLs in new tabs, list open tabs, switch tabs |
| `repl` | repl | Run JavaScript in the page via the sandboxed REPL (trusted input events, browserjs) |
| `extract_document` | extract_document | Fetch a URL and extract text (HTML, PDF, DOCX, XLSX) |
| `extract_image` | extract_image | Screenshot the window or extract an element image |
| `bookmarks` | bookmarks | Bookmark tree search, create, update, move, remove |
| `browser_extensions` | browser_extensions | List, inspect, enable, disable, uninstall extensions |
| `browser_workspace` | browser_workspace | Tabs, groups, history, recently closed, downloads, reading list |
| `agent_scheduler` | agent_scheduler | Named alarm schedules and one-off notifications |
| `agent_task` | agent_task | **Delegate a task to the sidepanel agent itself** (it uses its injected skills, vision, artifacts; the task runs visibly in the panel). Sync wait up to ~100s, then poll with `status` / `cancel` |
| `skill` | skill | List, create, update, rewrite, delete browser skills |
| `debugger` | debugger | Execute JavaScript in the MAIN world (only when debugger mode is enabled) |

Interactive tools are excluded: `ask_user_which_element` needs the user to
click inside the side panel and would stall an external agent.

## Extension settings

Settings > MCP Bridge:

- **Enable MCP bridge** (default on): whether the panel connects to the bridge.
- **Bridge port** (default 8377): must match the port the bridge listens on.
- **Status**: connection state (`Connected`, `Connecting...`, `Waiting for
  bridge...`, `Disabled`, `Error`).

## Semantics and limitations

- **Side panel must be open.** Tool calls only work while a Sitegeist side
  panel is open (that is where the tools execute). While it is closed, calls
  fail with a clear error; once a panel connects, the bridge notifies clients
  that the tool list changed.
- **"Current tab"** is the active tab of the window the side panel is attached
  to, exactly as for sidepanel-originated calls.
- **One master bridge, many MCP clients.** Several pi sessions can use the
  bridge simultaneously (see "Multiple MCP clients at the same time" above);
  tool calls are serialized through the one connected side panel.
- **Cancellation.** When the MCP client cancels a call (user interrupt or
  timeout), the bridge forwards an abort to the panel, which cancels the
  tool's `AbortSignal`. Tool results arriving after cancellation are dropped.
- **Delegation (`agent_task`).** pi can hand a whole task to the sidepanel agent instead of driving tools step-by-step. The task runs in a **fresh panel session** - the user's current conversation is never touched, and the panel navigates back to it when the task finishes (the task conversation stays in the session list). `run` accepts immediately and the panel starts working; poll `action=status` until `done` and read the reply (the agent auto-loads domain skills, can take screenshots, and can involve the user - element pick, confirmation dialogs - right in the panel). Note this runs a second LLM agent (the panel's own model), and page content seen by it flows back into pi - treat both sides as untrusted input.
- **Timeout.** Long calls (page loads, document extraction) are allowed by the
  registered 120s per-request timeout. Long-running tool calls beyond that
  need a higher `timeout` in the server entry.
- **Tool set updates.** The catalog is rebuilt when the panel (re)connects.
  Toggling debugger mode or the MCP Bridge setting takes effect on the next
  connection (toggle the setting or reopen the panel).

## Security model

- The bridge binds to `127.0.0.1` only and performs no authentication. On a
  single-user machine this means any local process could connect to the port
  and drive the browser - only run the bridge yourself and close it when not
  in use (pi terminates it when the session ends).
- Web pages cannot reach the endpoint (loopback address, no CORS headers, and
  Chrome's Private Network Access blocks public/private pages from hitting
  localhost).
- Tool calls run with the extension's full capabilities, including tools that
  mutate state (bookmarks, downloads, extensions). External MCP clients should
  be trusted accordingly.

## Troubleshooting

- **pi reports the server failed to connect** - check `pi mcp list`, then run
  `node scripts/mcp-bridge.mjs` manually and read its stderr.
- **`Port ... is in use by another process (not a sitegeist bridge)`** -
  something unrelated holds the port. Stop it or use `--port` plus a matching
  port in Settings > MCP Bridge.
- **`MCP connection closed` in pi after a config reload** - was fixed by the
  master/proxy model; if it still appears, check for a stale bridge process
  (`pgrep -fl mcp-bridge`) holding the port and kill it, then rerun `/mcp`.
- **Tools missing in pi** - the side panel was closed when the session listed
  tools. Open the panel; the bridge sends `tools/list_changed` and pi refreshes
  automatically. `/mcp` inside pi shows the current state.
- **Calls fail with "side panel is not connected"** - open the panel, or check
  the port matches and the MCP Bridge setting is enabled.
