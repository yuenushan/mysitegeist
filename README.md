<p align="center">
  <img src="media/hero.png" alt="Sitegeist" width="400">
</p>

An AI assistant that lives in your browser sidebar. Built for collaboration, not autonomy theater. You guide, it executes.

Sitegeist can automate repetitive web tasks, extract data from any website, navigate across pages, fill out forms, compare products, compile research, and transform what it finds into documents, spreadsheets, or whatever you need. It works on any website through a Chrome/Edge side panel, using the AI provider of your choice.

Bring your own API key or log in with an existing subscription (Anthropic Claude, OpenAI/ChatGPT, GitHub Copilot, Google Gemini). Your data stays on your machine. Nothing is collected or tracked.

## Download & Install

Visit [sitegeist.ai](https://sitegeist.ai) for download links and step-by-step installation instructions.

Requires Chrome 141+ or Edge equivalent.

## Development

Sitegeist is self-contained: all upstream dependencies are vendored in this repo under `vendor/`, so a single clone installs and builds with no sibling checkouts.

### Fresh machine setup

Requirements: Node >= 22 (CI baseline), npm access to the registry, Chrome 141+ or Edge equivalent.

```bash
git clone git@github.com:yuenushan/mysitegeist.git
cd mysitegeist
npm install        # installs deps, links the vendored packages, sets up the Husky hook
npm run build      # produces dist-chrome/ (gitignored - it does not exist in a fresh clone)
```

Optional, only for running the full `./check.sh` (marketing site checks): `(cd site && npm install)`.

Then load the extension (steps in "Loading the extension" below): select `dist-chrome/` as an unpacked extension and enable **Allow user scripts** plus **Allow access to file URLs** in its details page.

Daily loop: edit `src/`, `npm run build`, reload the extension card in chrome://extensions - or start `./dev.sh` for watchers with hot reload. Run `./check.sh` before committing.

### Vendored dependencies

Layout:

```
sitegeist/
  vendor/
    mini-lit/               # @mariozechner/mini-lit 0.2.1 (frozen)
    pi-mono/packages/
      ai/                   # @mariozechner/pi-ai 0.62.0 (frozen)
      agent/                # @mariozechner/pi-agent-core 0.62.0 (frozen)
      web-ui/               # @mariozechner/pi-web-ui 0.62.0 (frozen + local patches)
```

Frozen sources: `badlogic/pi-mono@21950c5ba4` (upstream deleted `packages/web-ui` afterwards, so this snapshot cannot be replaced by a fresh clone) and `mini-lit` 0.2.1, plus local web-ui patches (generic `suggestionProvider` hook, artifacts `openExternal` hooks - see CHANGELOG).

`npm install` links the vendored packages via `file:` dependencies; `overrides` in package.json pins all `@mariozechner/*` resolution to `vendor/` so nothing is ever fetched from the npm registry.

Start all dev watchers (vendored packages, sitegeist extension, marketing site):

```bash
./dev.sh
```

Changes in `vendor/mini-lit` and `vendor/pi-mono/packages/web-ui` are rebuilt automatically and picked up by the sitegeist watcher. After editing `vendor/pi-mono/packages/ai` or `agent`, rebuild manually: `cd vendor/pi-mono/packages/<name> && npm run build`.

To run only the extension watcher without dependencies or the marketing site:

```bash
npm run dev
```

### Loading the extension

1. Open `chrome://extensions/` or `edge://extensions/`
2. Enable Developer mode
3. Click Load unpacked
4. Select `sitegeist/dist-chrome/`
5. Click "Details" on the Sitegeist extension and enable:
   - **Allow user scripts**
   - **Allow access to file URLs**

The extension hot-reloads when the dev watcher rebuilds.

### First run

On first launch, Sitegeist prompts you to connect at least one AI provider. You can log in with a subscription or enter an API key.

Some subscription logins require the CORS proxy (configurable in Settings > Proxy). The default proxy is `https://proxy.mariozechner.at/proxy`.

## MCP server (pi integration)

Sitegeist's agent tools can be driven from an external MCP client such as pi: it navigates tabs, runs in-page JavaScript, extracts documents and images, and manages bookmarks, tabs, history, downloads, extensions and skills.

```bash
node scripts/mcp-register.mjs   # registers the bridge in ~/.pi/agent/mcp.json
```

Then start a pi session and open the Sitegeist side panel - its tools appear as `mcp__sitegeist__<tool>`. The bridge (`scripts/mcp-bridge.mjs`) is spawned by pi and relays calls to the side panel over a loopback WebSocket; no inbound connections reach the browser. See [docs/mcp.md](docs/mcp.md) for architecture, other MCP clients, and troubleshooting.

## Checks

```bash
./check.sh
```

Runs formatting, linting, and type checking for the extension and the `site/` subproject.

The Husky pre-commit hook runs the same checks before each commit.

## Building

```bash
npm run build
```

The unpacked extension is written to `dist-chrome/`.

## Updating the website

```bash
cd site && ./run.sh deploy
```

Builds the static site and uploads it to `sitegeist.ai`. Requires SSH access to `slayer.marioslab.io`.

## Releasing

```bash
./release.sh patch   # 1.0.0 -> 1.0.1
./release.sh minor   # 1.0.0 -> 1.1.0
./release.sh major   # 1.0.0 -> 2.0.0
```

Bumps the version in `static/manifest.chrome.json`, commits, tags, and pushes. GitHub Actions builds the extension and creates a release at [github.com/badlogic/sitegeist/releases](https://github.com/badlogic/sitegeist/releases).

## License

AGPL-3.0. See [LICENSE](LICENSE).
