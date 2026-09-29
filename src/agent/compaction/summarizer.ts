import type { Model, ThinkingLevel } from "@mariozechner/pi-ai";
import { createStreamFn } from "@mariozechner/pi-web-ui";
import type { SummaryRequest } from "./compaction.js";

/**
 * LLM request boundary for compaction summaries.
 *
 * Reuses the same proxy + API key plumbing as the agent's own requests by
 * delegating to pi-web-ui's createStreamFn and sitegeist's OAuth-aware key
 * resolution. Retries transient failures with linear backoff.
 */

export interface SummaryRequestDeps {
	getApiKey: () => Promise<string | undefined>;
	getProxyUrl: () => Promise<string | undefined>;
}

export interface SummaryRequestOptions {
	model: Model<any>;
	/** Agent-state thinking level includes "off"; the provider option does not. */
	thinkingLevel?: ThinkingLevel | "off";
	signal?: AbortSignal;
}

const RETRY_DELAYS_MS = [1000, 2000, 4000];

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createSummaryRequest(deps: SummaryRequestDeps, options: SummaryRequestOptions): SummaryRequest {
	const { model, thinkingLevel, signal } = options;

	return async ({ systemPrompt, messages, maxTokens }) => {
		const [apiKey, proxyUrl] = await Promise.all([deps.getApiKey(), deps.getProxyUrl()]);
		const streamFn = createStreamFn(() => Promise.resolve(proxyUrl));

		let lastError: unknown;
		for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
			if (attempt > 0) {
				await sleep(RETRY_DELAYS_MS[attempt - 1]);
			}
			try {
				const response = await (
					await streamFn(
						model,
						{ systemPrompt, messages },
						{
							apiKey,
							maxTokens,
							signal,
							reasoning: thinkingLevel === "off" ? undefined : thinkingLevel,
						},
					)
				).result();
				return {
					text: response.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n"),
					usage: response.usage,
					stopReason: response.stopReason,
					errorMessage: response.errorMessage,
				};
			} catch (err) {
				lastError = err;
				if (signal?.aborted) break;
			}
		}
		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	};
}
