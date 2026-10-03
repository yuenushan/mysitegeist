#!/usr/bin/env node

/**
 * Registers the Sitegeist MCP bridge with pi by adding an entry to the
 * user-level ~/.pi/agent/mcp.json (other entries are preserved).
 *
 * The bridge script path is resolved from this file's location, so the
 * registered entry works regardless of where pi is later started.
 *
 * Usage:
 *   node scripts/mcp-register.mjs             # add or update the entry
 *   node scripts/mcp-register.mjs --port N    # also pin the bridge port
 *   node scripts/mcp-register.mjs --remove    # remove the entry
 *
 * After registering, every pi session spawns the bridge automatically.
 * Tool calls only succeed while the Sitegeist side panel is open.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_NAME = "sitegeist";

const args = process.argv.slice(2);
const remove = args.includes("--remove");
let port = null;
const portIndex = args.indexOf("--port");
if (portIndex !== -1) {
	port = Number(args[portIndex + 1]);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		console.error(`Invalid --port value: ${args[portIndex + 1]}`);
		process.exit(1);
	}
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bridgeScript = join(repoRoot, "scripts", "mcp-bridge.mjs");
if (!existsSync(bridgeScript)) {
	console.error(`Bridge script not found at ${bridgeScript} - run this script from the sitegeist repo.`);
	process.exit(1);
}

const configPath = join(homedir(), ".pi", "agent", "mcp.json");

let config = {};
try {
	config = JSON.parse(await readFile(configPath, "utf8"));
} catch (error) {
	if (error?.code !== "ENOENT") {
		console.error(`Failed to parse ${configPath}: ${error.message}`);
		console.error("Fix or remove the file and retry.");
		process.exit(1);
	}
}
if (typeof config !== "object" || config === null || Array.isArray(config)) {
	console.error(`${configPath} does not contain a JSON object.`);
	process.exit(1);
}
if (config.mcpServers !== undefined && (typeof config.mcpServers !== "object" || config.mcpServers === null)) {
	console.error(`"mcpServers" in ${configPath} is not an object.`);
	process.exit(1);
}

if (!config.mcpServers) config.mcpServers = {};

if (remove) {
	if (!(SERVER_NAME in config.mcpServers)) {
		console.log(`No "${SERVER_NAME}" entry found in ${configPath} - nothing to remove.`);
		process.exit(0);
	}
	delete config.mcpServers[SERVER_NAME];
} else {
	config.mcpServers[SERVER_NAME] = {
		command: "node",
		args: [bridgeScript],
		...(port ? { env: { SITEGEIST_MCP_PORT: String(port) } } : {}),
		timeout: 120,
		description:
			"Control the user's Chrome browser via the Sitegeist extension: navigate tabs, run in-page JS, extract documents/images, manage bookmarks, tabs, history, downloads, extensions, schedules and skills. Requires the Sitegeist side panel to be open.",
	};
}

await mkdir(dirname(configPath), { recursive: true });
await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

if (remove) {
	console.log(`Removed "${SERVER_NAME}" from ${configPath}`);
} else {
	console.log(`Registered "${SERVER_NAME}" in ${configPath}:`);
	console.log(`  command: node ${bridgeScript}${port ? ` (port ${port})` : ""}`);
	console.log("");
	console.log("Next steps:");
	console.log("  1. Open the Sitegeist side panel in Chrome (tools only work while it is open)");
	console.log("  2. Start a pi session; the bridge is spawned automatically");
	console.log("  3. Tools appear as mcp__sitegeist__<tool> - run 'pi mcp list' to verify");
}
