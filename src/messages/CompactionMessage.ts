import type { Usage } from "@mariozechner/pi-ai";
import type { MessageRenderer } from "@mariozechner/pi-web-ui";
import { registerMessageRenderer } from "@mariozechner/pi-web-ui";
import { html, LitElement, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";

// ============================================================================
// COMPACTION MESSAGE TYPE
// ============================================================================

export interface CompactionMessage {
	role: "compaction";
	summary: string;
	/** Context tokens before compaction (what the summary replaces). */
	tokensBefore: number;
	timestamp: number;
	usage?: Usage;
}

// Extend CustomAgentMessages interface via declaration merging
declare module "@mariozechner/pi-agent-core" {
	interface CustomAgentMessages {
		compaction: CompactionMessage;
	}
}

// ============================================================================
// COMPACTION MESSAGE ELEMENT
// ============================================================================

@customElement("compaction-message")
export class CompactionMessageElement extends LitElement {
	@property() summary = "";
	@property({ type: Number }) tokensBefore = 0;

	protected createRenderRoot() {
		return this; // light DOM
	}

	override render(): TemplateResult {
		return html`
			<div class="mx-4 my-2">
				<details class="border border-border rounded-lg bg-card/50 text-sm">
					<summary
						class="px-3 py-2 cursor-pointer text-xs text-muted-foreground select-none hover:text-foreground transition-colors"
					>
						Context compacted - ~${this.tokensBefore.toLocaleString()} tokens summarized (click to view
						summary)
					</summary>
					<div
						class="px-3 pb-3 pt-2 mt-1 border-t border-border text-xs text-muted-foreground whitespace-pre-wrap"
					>
						${this.summary}
					</div>
				</details>
			</div>
		`;
	}
}

// ============================================================================
// RENDERER
// ============================================================================

const compactionRenderer: MessageRenderer<CompactionMessage> = {
	render: (message) => {
		return html`<compaction-message .summary=${message.summary} .tokensBefore=${message.tokensBefore}></compaction-message>`;
	},
};

// ============================================================================
// REGISTER
// ============================================================================

export function registerCompactionRenderer() {
	registerMessageRenderer("compaction", compactionRenderer);
}

// ============================================================================
// HELPER
// ============================================================================

export function createCompactionMessage(summary: string, tokensBefore: number, usage?: Usage): CompactionMessage {
	return {
		role: "compaction",
		summary,
		tokensBefore,
		timestamp: Date.now(),
		usage,
	};
}
