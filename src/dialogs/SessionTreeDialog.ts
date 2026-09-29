import { DialogContent, DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import i18n from "@mariozechner/mini-lit/dist/i18n.js";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { listJumpPoints, pathToRoot, type SessionTree, type TreeJumpPoint } from "../agent/tree/session-tree.js";

function previewOf(message: AgentMessage): string {
	switch (message.role) {
		case "user": {
			const content = (message as { content: string | Array<{ type: string; text?: string }> }).content;
			if (typeof content === "string") return content;
			return (
				content
					.filter((block) => block.type === "text" && block.text)
					.map((block) => block.text as string)
					.join(" ") || "(attachment)"
			);
		}
		case "navigation":
			return `→ ${(message as { url?: string }).url ?? "navigated"}`;
		case "compaction":
			return `[context summary] ${(message as { summary?: string }).summary?.slice(0, 120) ?? ""}`;
		default:
			return `[${message.role}]`;
	}
}

function formatTime(timestamp: number): string {
	const date = new Date(timestamp);
	const now = new Date();
	const sameDay = date.toDateString() === now.toDateString();
	if (sameDay) {
		return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	}
	return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

@customElement("sitegeist-session-tree-dialog")
export class SessionTreeDialog extends DialogBase {
	@state() private tree: SessionTree | null = null;
	@state() private activeLeafId: string | null = null;
	@state() private activePathIds = new Set<string>();

	private onJumpCallback?: (entryId: string) => void;

	protected modalWidth = "min(600px, 90vw)";
	protected modalHeight = "min(700px, 90vh)";

	static open(tree: SessionTree, activeLeafId: string | null, onJump: (entryId: string) => void) {
		const dialog = new SessionTreeDialog();
		dialog.tree = tree;
		dialog.activeLeafId = activeLeafId;
		dialog.activePathIds = new Set(pathToRoot(tree, activeLeafId).map((entry) => entry.id));
		dialog.onJumpCallback = onJump;
		dialog.open();
	}

	private handleJump(entryId: string) {
		if (this.onJumpCallback) {
			this.onJumpCallback(entryId);
		}
		this.close();
	}

	private roleLabel(role: string): string {
		switch (role) {
			case "user":
				return i18n("You");
			case "navigation":
				return i18n("Navigation");
			case "compaction":
				return i18n("Compaction");
			default:
				return role;
		}
	}

	protected override renderContent() {
		const points = this.tree ? listJumpPoints(this.tree) : [];

		return html`
			${DialogContent({
				className: "h-full flex flex-col",
				children: html`
					${DialogHeader({
						title: i18n("Session branches"),
						description: i18n("Jump to a previous point; the next message starts a new branch there"),
					})}

					<div class="flex-1 overflow-y-auto mt-4 space-y-1">
						${
							points.length === 0
								? html`<div class="text-center py-8 text-muted-foreground text-sm">
									${i18n("No branch points yet")}
								</div>`
								: points.map((point) => this.renderPoint(point))
						}
					</div>
				`,
			})}
		`;
	}

	private renderPoint(point: TreeJumpPoint) {
		const { entry } = point;
		const isActiveLeaf = entry.id === this.activeLeafId;
		const isOnActivePath = this.activePathIds.has(entry.id);
		const isFork = point.branchCount > 1;
		// A point not on the active path belongs to an abandoned branch
		const isAbandoned = !isOnActivePath;

		return html`
			<div
				class="flex items-start gap-2 px-3 py-2 rounded-lg border transition-colors cursor-pointer ${
					isActiveLeaf
						? "border-primary/40 bg-secondary/40"
						: isOnActivePath
							? "border-transparent bg-secondary/20 hover:bg-secondary/40"
							: "border-border hover:bg-secondary/40"
				}"
				style="margin-left: ${Math.min(point.depth, 6) * 16}px"
				@click=${() => this.handleJump(entry.id)}
				title=${i18n("Continue from here")}
			>
				<div class="flex-1 min-w-0">
					<div class="flex items-center gap-2">
						<span class="text-xs font-medium ${isAbandoned ? "text-muted-foreground" : "text-foreground"}">
							${this.roleLabel(entry.message.role)}
						</span>
						<span class="text-[10px] text-muted-foreground">${formatTime(entry.timestamp)}</span>
						${
							isActiveLeaf
								? html`<span class="px-1.5 py-0.5 text-[10px] rounded-full bg-primary/20 text-primary font-medium">
										${i18n("Current")}
									</span>`
								: ""
						}
						${
							isFork
								? html`<span
										class="px-1.5 py-0.5 text-[10px] rounded-full bg-muted text-muted-foreground font-medium"
										title=${i18n("Branch position among siblings")}
									>
										${i18n("branch")} ${point.branchIndex + 1}/${point.branchCount}
									</span>`
								: ""
						}
					</div>
					<div class="text-xs ${isAbandoned ? "text-muted-foreground/70" : "text-muted-foreground"} line-clamp-2 mt-0.5">
						${previewOf(entry.message)}
					</div>
				</div>
			</div>
		`;
	}
}
