# Development Rules

## First Message
If the user did not give you a concrete task, read README.md first.

## Commands
- After code changes: run `./check.sh`. Fix all errors and warnings before committing.
- The user runs `./dev.sh` in a separate tmux session. Do not run `npm run dev` or `npm run build`.
- NEVER commit unless the user asks.

## Code Quality
- No `any` types unless absolutely necessary
- Check node_modules for external API type definitions instead of guessing
- NEVER use inline imports (no `await import(...)`, no `import("pkg").Type`)
- Always ask before removing functionality or code that appears intentional

## Dependencies
- `@mariozechner/mini-lit`, `@mariozechner/pi-ai`, `@mariozechner/pi-web-ui`, `@mariozechner/pi-agent-core` are linked via `file:` to sibling repos `../mini-lit` and `../pi-mono`
- Changes to those packages require rebuilding them (the dev watcher handles this)
- If you need to modify upstream code, edit it in `../pi-mono` or `../mini-lit` directly and rebuild

## Changelog
Location: `CHANGELOG.md`

### Format
Use these sections under `## [Unreleased]`:
- `### Breaking Changes`
- `### Added`
- `### Changed`
- `### Fixed`
- `### Removed`

### Rules
- New entries ALWAYS go under `## [Unreleased]`
- Append to existing subsections, do not create duplicates
- NEVER modify already-released version sections

## Releasing
When the user asks to do a release:
1. Ask: major, minor, or patch?
2. Ensure `CHANGELOG.md` has entries under `## [Unreleased]`
3. Run `./release.sh <major|minor|patch>`

The script bumps the version in `static/manifest.chrome.json`, finalizes the changelog, commits, tags, and pushes. GitHub Actions builds and publishes the release.

## Updating the Website
When the user asks to update the website:
```bash
cd site && ./run.sh deploy
```
Requires SSH access to `slayer.marioslab.io`.

The site is static HTML (no backend). Source is in `site/src/frontend/`.

## Style
- No emojis in commits, code, or comments
- No fluff or cheerful filler text
- Technical prose only, direct and concise

## Git Rules
- NEVER use `git add -A` or `git add .`
- ALWAYS use `git add <specific-file-paths>`
- NEVER use `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`
- NEVER use `git commit --no-verify`
- Include `fixes #<number>` or `closes #<number>` in commit messages when applicable

## Project Structure
```
src/
  sidepanel.ts          # Main entry point, agent setup, settings, rendering
  background.ts         # Service worker (sidepanel toggle, session locks)
  oauth/                # Browser OAuth flows (Anthropic, OpenAI, GitHub, Gemini)
  dialogs/              # Settings tabs, API key dialogs, welcome setup
  tools/                # Agent tools (navigate, REPL, extract-image, skills, debugger)
  messages/             # Custom message types (navigation, welcome)
  storage/              # IndexedDB storage (sessions, skills, costs)
  prompts/              # System prompt and token counting
  components/           # UI components (Toast, TabPill, OrbAnimation)
site/
  src/frontend/         # Static landing page and install instructions
static/
  manifest.chrome.json  # Extension manifest (version lives here)
```

## Fork Notes (yuenushan/mysitegeist)

This fork adds local-only conventions on top of upstream. Keep this section
when merging upstream changes.

### Remotes
- `origin` = git@github.com:yuenushan/mysitegeist.git (this fork - push work here,
  `main` tracks `origin/main`)
- `upstream` = https://github.com/badlogic/sitegeist.git (badlogic upstream,
  fetch-only in practice; renamed from `origin` - pull requests/updates come
  from here)

### Dependency pinning (IMPORTANT)
- `../pi-mono` MUST be the 2026-03-24 snapshot (upstream commit `21950c5ba4`).
  Upstream pi-mono removed `packages/web-ui` on 2026-05-20, which breaks this
  repo. The snapshot was installed from a GitHub tarball (no `.git` dir).
  Do NOT run `git pull` inside `../pi-mono`.
- `../mini-lit` is at HEAD (0.2.1) and needs `npm run build` once (tsc -> dist/).
- If `node_modules/@mariozechner/pi-web-ui` resolves to a non-existent path,
  the pi-mono snapshot was lost — re-download the tarball for `21950c5ba4`.

### Build & install workflow (this machine)
- Do NOT use `./dev.sh` / `npm run dev` (watchers + sibling deps are not set
  up for interactive use here).
- Use `./install.sh`: builds and rsyncs `dist-chrome/` into the directory
  Chrome loads (`~/Downloads/sitegeist` by default; override via CLI arg or
  `$SITEGEIST_INSTALL_DIR`). After it finishes, reload the extension in
  `chrome://extensions/`.

### Checks on this machine
- `./check.sh` works after `npm install -D typescript` was added and
  `cd site && npm install` was run. If it fails with `tsc: command not found`,
  the node_modules were wiped — re-run `npm install` in the repo root.

### Self-testing before handing off (REQUIRED)
After finishing a change, run everything that can run before asking the user
to verify. Only hand off what genuinely needs real interaction, LLM traffic,
or visual judgment. In practice:

1. `./check.sh` — always; fix all errors AND warnings.
2. Smoke-test pure logic with `npx tsx` throwaway scripts (tree/compaction/
   storage helpers are importable without a browser). Assert the expected
   semantics and print a pass/fail summary. Session-tree and compaction bugs
   shipped because no smoke test covered the linear-chain case — cover the
   ordinary case plus the regression being fixed.
3. Verify chrome API usage against `node_modules/@types/chrome` .d.ts when
   touching new APIs (e.g. chrome.readingList is addEntry/updateEntry, not
   the addReadingItem names found in blog posts).
4. Assert on build output after `./install.sh`: grep `dist-chrome/` for what
   must be there (custom element defines, tool registration, permissions) and
   what must NOT (DOM references in `background.js` — the service worker has
   no window/document and fails to register, which silently kills the
   sidepanel toggle).
5. When Chrome runs with remote debugging (:9222), verify against the live
   extension instead of guessing: `chrome.developerPrivate.getExtensionInfo`
   for manifest errors and SW registration, attach to the sidepanel target to
   inspect DOM/runtime state (message roles, customElements.get, element
   geometry), open dialogs programmatically, and check chrome.storage data.
   Reload the extension via `developerPrivate.reload` when needed.
6. Close out by telling the user exactly which acceptance items still need
   their hands (real LLM runs, native dialogs, visual checks, multi-window
   behavior). Never present "installed" as "verified".

### Agent tools
- Tools live in `src/tools/<name>.ts`: TypeBox schema + class implementing
  `AgentTool` + a `ToolRenderer` registered via `registerToolRenderer`.
- New tools must be mounted in the `toolsFactory` array in `src/sidepanel.ts`
  and get their permission added to `static/manifest.chrome.json`.
- `src/tools/bookmarks.ts` (operation-dispatch design) is the reference for
  single-tool-multi-operation patterns; `navigate.ts`/`extract-image.ts` for
  single-purpose tools.
- Chrome API errors: wrap promise APIs so rejections become friendly Errors
  (see `call()` in bookmarks.ts). Narrow `args.x` into a local `const` before
  using it inside closures - property narrowing does not survive closures.
