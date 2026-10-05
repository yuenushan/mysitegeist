# Changelog

## [Unreleased]

### Fixed
- navigate hung forever when the target page never loaded: the wait was DOMContentLoaded-only with no onErrorOccurred listener and no timeout, so an unreachable host (e.g. net::ERR_CONNECTION_TIMED_OUT) left the tool call spinning indefinitely and wedged the agent run (observed with a blocked fandom.com wiki). Navigation now fails fast with the actual network error, a 30s hard timeout backstops hangs with no error event, error-page DOMContentLoaded events (chrome-error://) resolve as failures instead of succeeding with a chrome-error URL, and the tool description tells the agent to switch sources instead of retrying
- Setup tool's set_default_model saved lastUsedModel as a bare { provider, id } pair; restoring it handed the agent a model without api/baseUrl, so every message failed with "No API provider registered for api: undefined". It now persists a complete Model: known providers resolve via the built-in registry, custom/proxy providers synthesize an OpenAI-compatible record from the configured base URL. All model sources (session restore, saved default, provider-key defaults) now pass through the same normalization in createAgent - sessions created while a corrupt model was active also heal on load - and the repaired model is written back to the stored default. set_provider_key now persists its baseUrl argument (previously only echoed it back), test_provider falls back to the persisted base URL, and setup status shows configured base URLs
- kdev skill reverted out of sitegeist defaults: deeper testing showed userScripts USER_SCRIPT world fetch is blocked at the network layer even with a permissive configureWorld CSP (connect-src *), so API-direct skills cannot run in the browserjs sandbox regardless of the network world - kdev stays as a pi-side skill (ks-cookie path, verified working). Recorded as a platform constraint: API-direct skills belong to pi-side skills, DOM-extraction skills to sitegeist
- browserjs `$` silent failure fixed: buildWrapperCode used string-form String.replace, so `$` sequences in user code or skill libraries (jQuery-style helpers, `### Fixed\n`/``` templates) were interpreted as replacement patterns - `const $ = ...` became a duplicate `const $ = ...` and the injected script failed with a swallowed SyntaxError (agent discovered during kdev skill work). Replacements now use function form; verified with a 9-case bundle smoke over the real buildWrapperCode
- Dev hot-reload client (live-reload.ts) is no longer bundled into production builds: it retried a WebSocket to ws://localhost:8765 every 2 seconds whenever the dev server was not running, spamming one console error in every sidepanel session; the esbuild pipeline now stubs the module unless building with --watch
- Manual compaction on a small session no longer produces a hollow all-(none) summary: sessions whose entire history fits the keep-recent budget, or whose compactable prefix contains only UI-only messages (welcome/artifact), are now rejected as nothing to compact; summarizeMessages additionally refuses to run on an empty LLM-visible conversation
- Compaction summary messages now display at their chronological position (after the retained tail they summarize, before later turns) instead of at the top of the context list, where they ended up thousands of pixels above the viewport and appeared to be missing after compaction; LLM context order is unchanged

### Added
- http() in repl/browserjs: HTTP requests executed in the extension page context (<all_urls> host permissions, so cross-origin reads bypass page CORS and site cookies are included via credentials: 'include' by default). Safety model: same registrable domain (eTLD+1, small multi-part-suffix list) as the active tab is auto-allowed; cross-site origins show a one-per-origin confirmation dialog (PermissionDialog subclass, remembered for the panel session, denial throws into the sandbox). Options: method, headers, body, timeoutMs (30s default, 120s cap), maxBytes (2MB default, 10MB cap, streamed truncation with truncated flag), cookies toggle, referer/origin override via session-scoped declarativeNetRequest modifyHeaders rules. Provider wired into the sidepanel and MCP repl runtimes (also reachable inside browserjs() via the shared providers); repl/navigate prompts now document http() as the data channel and forbid navigating to API/JSON URLs to read data (the 2026-10-04 bilibili failure: page/sandbox fetch blocked by CSP, navigate-to-API hung until user abort)
- Network-enabled user script world for skills: skills can declare `network: true` (optionally `allowedHosts`) and run in a dedicated user script world with network access, while the default world stays fully offline (connect-src 'none'). Gated by an explicit consent switch in Settings > Skills; the fetch shadow enforces the host allowlist (best-effort against accidents). kdev skill migrated back to sitegeist on this path (API-direct personalView queries with SSO)

- MCP bridge: the extension's agent tools are exposed over MCP for external agents such as pi. `scripts/mcp-bridge.mjs` is a zero-dependency stdio MCP server that relays `tools/list` / `tools/call` over a loopback WebSocket to the side panel, which executes calls on the same tool instances as the sidepanel agent (navigate, repl, extract_document, extract_image, bookmarks, browser_extensions, browser_workspace, agent_scheduler, skill, debugger when debugger mode is on); the panel announces its tool catalog via hello and the bridge sends tools/list_changed when it changes; cancellations are forwarded as aborts. Multiple concurrent MCP clients are supported: the first bridge binds the port as master and later bridges connect as proxies forwarding over an internal HTTP /rpc endpoint, taking the port over automatically when the master dies. `scripts/mcp-register.mjs` upserts the user-level ~/.pi/agent/mcp.json entry (timeout 120s); new Settings > MCP Bridge tab controls enable/port and shows connection status; docs/mcp.md documents architecture, semantics and the security model
- agent_task MCP tool: pi can delegate a whole task to the sidepanel agent itself - the task runs in a FRESH panel session (the user's current conversation is untouched; the panel navigates back when done, the task conversation stays in the session list), runs visibly with skills auto-injection, screenshots and human-in-the-loop confirmations, and pi polls status until done and receives the agent's final reply. Implementation: the delegation protocol lives in chrome.storage.session (survives the session-switch page navigation), the fresh-session branch of initApp picks up pending delegations, and the tool is exposed in the MCP catalog but not added to the panel agent's own toolset (no self-delegation)
- Session branch tree: messages persist as a tree (id/parentId + active leaf), legacy flat sessions migrate on load; branch/rollback view in the header opens a jump-point list where selecting a point rewinds the conversation and the next message forks a new branch (abandoned branches are kept and marked)
- Slash-command suggestion menu in the chat input: typing "/" lists the /compact command and available skills with descriptions, filterable while typing, keyboard navigable (arrows, Enter/Tab to select, Escape to close); requires the web-ui snapshot rebuild adding a generic suggestionProvider to MessageEditor/AgentInterface/ChatPanel
- Context compaction ported from pi 0.87.1: automatic compaction between turns when context usage exceeds the model's window minus a reserve, manual compaction via a context usage badge in the header, and a collapsible summary entry in the transcript
- Compaction summaries re-enter the LLM context as a `<context-summary>` user message and support iterative updates across repeated compactions
- Live compaction preview: while a compaction runs, a status card with the streaming summary text appears at the end of the chat flow (AgentInterface gains a host-owned transientContent slot; SummaryRequest streams cumulative text via onDelta)
- browser_extensions tool: list/get/enable/disable/uninstall installed extensions via chrome.management; refuses to disable or uninstall the extension itself; uninstall requires confirm:true
- browser_workspace tool: list/close/group/ungroup tabs, search history, recently-closed sessions with restore, download list and pause/resume/cancel/show/open, reading list add/list/mark_read/remove keyed by URL; destructive operations (closing >5 tabs, download cancel) require confirm:true
- agent_scheduler tool: named alarm schedules and one-off system notifications; fired alarms show lightweight notifications from the service worker (no LLM work in the background); clicking a notification opens the side panel
- Context menu integration: Sitegeist submenu on selections, links and pages - send-to-summarize, translate, explain, add link to reading list (direct API write, no AI), analyze link, summarize page; AI actions open the side panel and auto-run a prefilled prompt
- Bookmarks tool gains an update operation (rename/re-url) via chrome.bookmarks.update
- /export command (and slash-menu entry): exports the current session to a standalone HTML page opened in a new tab - session metadata, the full system prompt, the tool list, the raw transcript with per-message raw JSON, and an "LLM Request View" showing the exact messages sent to the model after browserMessageTransformer. The page is fully pre-rendered static HTML with zero scripts (a blob:chrome-extension page inherits the extension CSP which blocks inline scripts), so it renders everywhere including saved/shared copies
- Gesture-gated extension actions now show a confirmation dialog in the sidepanel (ConfirmActionDialog, extending PermissionDialog): chrome.management.setEnabled, chrome.management.uninstall and chrome.downloads.open require a real user click per Chrome's security model, so the agent's request surfaces as a dialog whose click handler performs the call with the user gesture; cancelling cancels the operation. Adds the downloads.open permission for opening downloaded files

### Changed

- Navigation events are now activity-gated: while the agent is streaming, navigations are only steered into the run if the user interacted within the activity timeout (default 5 minutes, configurable), preventing a walked-away-from run from being extended into an endless nav-chasing loop; while idle, navigations are recorded silently and never trigger a response unless "Browse follow" is enabled (default off, new Browsing settings tab)
- SYSTEM_PROMPT gains an "Explaining Results" section (following Karpathy's note on readable LLM output, x.com/karpathy/status/2105819303471976479): explanations follow an ASD-STE100-inspired controlled style (one idea per sentence, short sentences, active voice, concrete words instead of vague qualifiers, one consistent term per concept, no marketing filler), and findings too complex for prose are explained visually via HTML artifacts (table/chart/diagram) with only the takeaways left in the chat reply

## [1.0.0] - 2026-03-15

### Added

- Browser-based OAuth login for Anthropic (Claude Pro/Max), OpenAI Codex (ChatGPT Plus/Pro), GitHub Copilot, and Google Gemini CLI
- Combined "API Keys & OAuth" settings tab with subscription login and API key entry
- Welcome setup dialog on first launch when no providers are configured
- Auto-select default model for the first provider with a key
- Provider and auth type indicator in the header bar
- Image extraction tool (`extract_image`) with selector and screenshot modes
- Subsequence-based fuzzy search in the model selector
- CORS proxy warning in OAuth sections (orange when enabled, red when disabled)
- GitHub Actions workflow for tagged releases
- `release.sh` script for version bumping and tagged releases

### Changed

- Default model changed to `claude-sonnet-4-6` with `medium` thinking level
- CORS proxy enabled by default
- Model selector only shows models from providers with configured keys
- API key prompt dialog now shows both OAuth login and API key entry for supported providers
- Tool execution set to sequential mode (parallel caused rendering issues in sidebar)
- Site converted to static (removed backend, admin, waitlist signups)
- Download links point to GitHub Releases
- License changed from MIT to AGPL-3.0

### Fixed

- Settings dialog tabs not responding to clicks (upstream `pi-web-ui` built with `tsgo` broke Lit decorator reactivity)
- CORS proxy toggle not updating (same root cause)
- Proxy not applied to API requests (esbuild bundled duplicate `streamSimple` references, breaking identity check)
- Model selector button not updating after picking a model (added `state_change` event to Agent)
- Duplicate tool component rendering during streaming (cleared streaming container on `message_end`)
- Screenshot tool capturing sidepanel instead of the webpage
