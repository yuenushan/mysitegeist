import i18n from "@mariozechner/mini-lit/dist/i18n.js";
import type { SandboxRuntimeProvider } from "@mariozechner/pi-web-ui";
import { customElement } from "lit/decorators.js";
import { PermissionDialog } from "../../dialogs/PermissionDialog.js";
import { HTTP_RUNTIME_PROVIDER_DESCRIPTION } from "../../prompts/prompts.js";

// ============================================================================
// Types
// ============================================================================

/** Options accepted by the sandbox-side http() helper. */
export interface HttpSandboxOptions {
	method?: string;
	headers?: Record<string, unknown>;
	body?: string;
	timeoutMs?: number;
	maxBytes?: number;
	cookies?: boolean;
	referer?: string;
	origin?: string;
}

/** Message sent from the sandbox to the sidepanel via sendRuntimeMessage. */
interface HttpSandboxRequest extends HttpSandboxOptions {
	type: "http-request";
	url: string;
}

/** Result returned to the sandbox for a completed request. */
export interface HttpResult {
	url: string;
	status: number;
	ok: boolean;
	headers: Record<string, string>;
	contentType: string;
	body: string;
	json?: unknown;
	size: number;
	truncated: boolean;
}

// ============================================================================
// Limits
// ============================================================================

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_MAX_BYTES = 10 * 1024 * 1024;

// ============================================================================
// eTLD+1 (registrable domain) approximation
// ============================================================================

/**
 * Small hardcoded list of common multi-part public suffixes. A full PSL is
 * overkill here: the check only needs to be right for mainstream sites, and a
 * mismatch degrades safely to "cross-site" (user confirmation).
 */
const MULTI_PART_SUFFIXES = new Set([
	"co.uk",
	"org.uk",
	"ac.uk",
	"gov.uk",
	"me.uk",
	"com.au",
	"net.au",
	"org.au",
	"co.jp",
	"ne.jp",
	"or.jp",
	"ac.jp",
	"com.cn",
	"net.cn",
	"org.cn",
	"gov.cn",
	"com.hk",
	"org.hk",
	"edu.hk",
	"com.tw",
	"org.tw",
	"edu.tw",
	"com.sg",
	"com.br",
	"com.mx",
	"co.in",
	"co.kr",
	"co.nz",
	"com.tr",
	"com.ar",
	"com.ua",
	"co.za",
	"com.sa",
]);

/**
 * Best-effort registrable domain (eTLD+1) for a hostname. IP literals and
 * single-label hosts (localhost) are returned unchanged, so they only compare
 * equal to themselves.
 */
export function registrableDomain(hostname: string): string {
	const host = hostname.toLowerCase().replace(/\.$/, "");
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":") || !host.includes(".")) {
		return host;
	}
	const labels = host.split(".");
	if (labels.length <= 2) return host;
	const lastTwo = labels.slice(-2).join(".");
	if (MULTI_PART_SUFFIXES.has(lastTwo)) return labels.slice(-3).join(".");
	return lastTwo;
}

function safeHostname(urlString: string): string | undefined {
	try {
		return new URL(urlString).hostname;
	} catch {
		return undefined;
	}
}

export function parseHttpUrl(raw: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error(`http(): invalid URL: ${raw}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`http(): only http/https URLs are supported, got ${parsed.protocol}`);
	}
	return parsed;
}

// ============================================================================
// Cross-site confirmation
// ============================================================================

/**
 * Origins approved by the user for the lifetime of this sidepanel session.
 * Module-level so it survives per-tool-call provider re-instantiation.
 */
const sessionApprovedOrigins = new Set<string>();

function rememberApprovedOrigin(origin: string) {
	if (sessionApprovedOrigins.size < 200) {
		sessionApprovedOrigins.add(origin);
	}
}

interface CrossSiteConfirmInfo {
	origin: string;
	tabUrl?: string;
}

@customElement("http-cross-site-confirm-dialog")
class HttpCrossSiteConfirmDialog extends PermissionDialog {
	private info!: CrossSiteConfirmInfo;

	static async request(info: CrossSiteConfirmInfo): Promise<boolean> {
		const dialog = new HttpCrossSiteConfirmDialog();
		dialog.info = info;
		return dialog.requestPermission(async () => ({ granted: true }));
	}

	protected header() {
		return {
			title: i18n("Allow request to this origin?"),
			description: i18n(
				"Sitegeist's agent wants to send an HTTP request to a different site than the one you are viewing.",
			),
		};
	}

	protected why(): string {
		return i18n(
			"Cross-site requests can carry your login session for that site, so the remote server sees the request as coming from you. Only allow origins you trust.",
		);
	}

	protected what(): string[] {
		return [
			i18n("Request origin:") + " " + this.info.origin,
			i18n("Active tab:") + " " + (this.info.tabUrl || i18n("unknown")),
			i18n("If you allow it, this origin is remembered for the rest of this session."),
		];
	}

	protected override denyLabel(): string {
		return i18n("Deny");
	}

	protected override confirmLabel(): string {
		return i18n("Allow");
	}
}

// ============================================================================
// DNR header overrides (Referer/Origin)
// ============================================================================

// Session rules share the id space with static/dynamic rules of this
// extension (static ids are 1..5 in cors-rules.json). A random base keeps
// across-reload collisions effectively impossible.
let nextHeaderRuleId = 4_000_000 + Math.floor(Math.random() * 100_000);

function validHttpUrl(raw: string): string {
	parseHttpUrl(raw); // throws unless http(s)
	return raw;
}

async function addHeaderOverrideRule(
	url: URL,
	referer: string | undefined,
	origin: string | undefined,
): Promise<number[]> {
	if (!chrome.declarativeNetRequest?.updateSessionRules || (!referer && !origin)) {
		return [];
	}
	const requestHeaders: chrome.declarativeNetRequest.ModifyHeaderInfo[] = [];
	if (referer) {
		requestHeaders.push({ header: "Referer", operation: "set", value: referer });
	}
	if (origin) {
		requestHeaders.push({ header: "Origin", operation: "set", value: origin });
	}
	const id = nextHeaderRuleId++;
	try {
		await chrome.declarativeNetRequest.updateSessionRules({
			addRules: [
				{
					id,
					priority: 1,
					action: { type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS, requestHeaders },
					condition: {
						requestDomains: [url.hostname],
						resourceTypes: [chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST],
					},
				},
			],
		});
		return [id];
	} catch (error) {
		console.warn("[HttpRuntimeProvider] Failed to add header override rule:", error);
		return [];
	}
}

async function removeHeaderOverrideRules(ruleIds: number[]): Promise<void> {
	if (ruleIds.length === 0 || !chrome.declarativeNetRequest?.updateSessionRules) return;
	try {
		await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ruleIds });
	} catch (error) {
		console.warn("[HttpRuntimeProvider] Failed to remove header override rule:", error);
	}
}

// ============================================================================
// Fetch helpers
// ============================================================================

export function normalizeMethod(raw: string | undefined): string {
	const method = (raw || "GET").toUpperCase();
	if (!/^[A-Z][A-Z0-9!#$%&'*+.^_`|~-]*$/.test(method)) {
		throw new Error(`http(): invalid HTTP method: ${method}`);
	}
	return method;
}

function sanitizeRequestHeaders(raw: Record<string, unknown> | undefined): Record<string, string> {
	const headers: Record<string, string> = {};
	if (!raw) return headers;
	for (const [key, value] of Object.entries(raw)) {
		if (value === undefined || value === null) continue;
		headers[key] = String(value);
	}
	return headers;
}

export async function readBodyCapped(
	response: Response,
	maxBytes: number,
): Promise<{ text: string; size: number; truncated: boolean }> {
	if (!response.body) {
		return { text: "", size: 0, truncated: false };
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let received = 0;
	let truncated = false;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		if (received + value.byteLength > maxBytes) {
			const keep = value.subarray(0, maxBytes - received);
			if (keep.length > 0) chunks.push(keep);
			received += keep.byteLength;
			truncated = true;
			try {
				await reader.cancel();
			} catch {
				// stream already closed
			}
			break;
		}
		chunks.push(value);
		received += value.byteLength;
	}
	const merged = new Uint8Array(received);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { text: new TextDecoder("utf-8").decode(merged), size: received, truncated };
}

function looksLikeJson(text: string): boolean {
	const trimmed = text.trimStart();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
	return true;
}

// ============================================================================
// Provider
// ============================================================================

/**
 * Exposes http() to REPL and browserjs() code. Requests are executed in the
 * extension page context (this sidepanel), which holds <all_urls> host
 * permissions: cross-origin reads are not subject to page CORS, and cookies
 * for the target site are included by default (credentials: include).
 *
 * Safety model (matches the sidepanel agent's confirm-gated actions):
 * - Same registrable domain as the active tab: allowed automatically.
 * - Cross-origin targets: one confirmation per origin, remembered for the
 *   session. Denial throws an error into the sandbox.
 */
export class HttpRuntimeProvider implements SandboxRuntimeProvider {
	getData(): Record<string, any> {
		return {};
	}

	getRuntime(): (sandboxId: string) => void {
		// Stringified into the sandbox - must not close over imports.
		return (_sandboxId: string) => {
			const sendRuntimeMessage = (window as any).sendRuntimeMessage;
			if (typeof sendRuntimeMessage !== "function") {
				throw new Error("sendRuntimeMessage is not available in this context");
			}
			(window as any).http = async (url: string, options: Record<string, unknown> = {}) => {
				if (typeof url !== "string" || url.length === 0) {
					throw new Error("http(url, options): url must be a non-empty string");
				}
				const response = await sendRuntimeMessage({
					type: "http-request",
					url,
					method: options.method,
					headers: options.headers,
					body: options.body,
					timeoutMs: options.timeoutMs,
					maxBytes: options.maxBytes,
					cookies: options.cookies,
					referer: options.referer,
					origin: options.origin,
				});
				if (!response.success) {
					throw new Error(response.error || "http() request failed");
				}
				return response.result;
			};
		};
	}

	async handleMessage(message: any, respond: (response: any) => void): Promise<void> {
		if (message.type !== "http-request") return;
		try {
			const result = await this.executeRequest(message as HttpSandboxRequest);
			respond({ success: true, result });
		} catch (error) {
			respond({ success: false, error: (error as Error)?.message || String(error) });
		}
	}

	getDescription(): string {
		return HTTP_RUNTIME_PROVIDER_DESCRIPTION;
	}

	private async executeRequest(req: HttpSandboxRequest): Promise<HttpResult> {
		const url = parseHttpUrl(req.url);
		const method = normalizeMethod(req.method);
		const timeoutMs = Math.min(Math.max(req.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1), MAX_TIMEOUT_MS);
		const maxBytes = Math.min(Math.max(req.maxBytes ?? DEFAULT_MAX_BYTES, 1), MAX_MAX_BYTES);

		const allowed = await this.isAllowed(url);
		if (!allowed.granted) {
			throw new Error(`Request to ${url.origin} was denied by the user.`);
		}

		const referer = req.referer ? validHttpUrl(req.referer) : undefined;
		const origin = req.origin ? validHttpUrl(req.origin) : undefined;
		const ruleIds = await addHeaderOverrideRule(url, referer, origin);

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
		try {
			const response = await fetch(url, {
				method,
				headers: sanitizeRequestHeaders(req.headers),
				body: method === "GET" || method === "HEAD" ? undefined : req.body,
				credentials: req.cookies === false ? "omit" : "include",
				redirect: "follow",
				signal: controller.signal,
			});

			const headers: Record<string, string> = {};
			response.headers.forEach((value, key) => {
				headers[key] = value;
			});
			const contentType = response.headers.get("content-type") || "";
			const { text, size, truncated } = await readBodyCapped(response, maxBytes);

			let json: unknown;
			if (/json/i.test(contentType) || looksLikeJson(text)) {
				try {
					json = JSON.parse(text);
				} catch {
					// Not JSON despite the hint - leave json undefined.
				}
			}

			return {
				url: response.url || url.href,
				status: response.status,
				ok: response.ok,
				headers,
				contentType,
				body: text,
				json,
				size,
				truncated,
			};
		} catch (error) {
			if (controller.signal.aborted) {
				throw new Error(
					`http(): request to ${url.origin} was aborted (timed out after ${timeoutMs} ms) or stopped by the user`,
				);
			}
			throw new Error(`http(): request to ${url.origin} failed: ${(error as Error)?.message || String(error)}`);
		} finally {
			clearTimeout(timer);
			await removeHeaderOverrideRules(ruleIds);
		}
	}

	private async isAllowed(url: URL): Promise<{ granted: boolean }> {
		if (sessionApprovedOrigins.has(url.origin)) {
			return { granted: true };
		}

		let tabUrl: string | undefined;
		try {
			const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
			tabUrl = tab?.url;
		} catch (error) {
			console.warn("[HttpRuntimeProvider] Failed to query active tab:", error);
		}

		const tabHost = tabUrl ? safeHostname(tabUrl) : undefined;
		const sameSite = !!tabHost && registrableDomain(tabHost) === registrableDomain(url.hostname);
		if (sameSite) {
			return { granted: true };
		}

		const granted = await HttpCrossSiteConfirmDialog.request({ origin: url.origin, tabUrl });
		if (granted) {
			rememberApprovedOrigin(url.origin);
		}
		return { granted };
	}
}
