import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import i18n from "@mariozechner/mini-lit/dist/i18n.js";
import { Label } from "@mariozechner/mini-lit/dist/Label.js";
import { SettingsTab } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { getSitegeistStorage } from "../storage/app-storage.js";
import {
	type EditorState,
	emptyRow,
	type ModelRow,
	type ProviderRecord,
	type ProviderType,
	recordFromEditor,
	testConnection,
	WANQING_PRESETS,
} from "../utils/custom-provider-utils.js";

/**
 * Custom model providers (Wanqing gateway, self-hosted proxies, ...).
 *
 * A provider record lives in the `custom-providers` store and carries a list
 * of complete pi-ai Model records; the model selector merges those into its
 * menu automatically. The API key is stored separately in `provider-keys`
 * (keyed by provider id) because that is what the send path reads.
 */

@customElement("custom-models-tab")
export class CustomModelsTab extends SettingsTab {
	@state() private providers: ProviderRecord[] = [];
	@state() private editor: EditorState | null = null;
	@state() private testResult: string | null = null;
	@state() private testing = false;
	@state() private error: string | null = null;

	async connectedCallback() {
		super.connectedCallback();
		await this.reload();
	}

	private async reload() {
		try {
			const storage = getSitegeistStorage();
			const records = await storage.customProviders.getAll();
			this.providers = records
				.filter((p) => p.type !== "ollama" && p.type !== "llama.cpp" && p.type !== "vllm" && p.type !== "lmstudio")
				.map((p) => ({
					id: p.id,
					name: p.name,
					type: p.type as ProviderType,
					baseUrl: p.baseUrl,
					models: p.models || [],
				}))
				.sort((a, b) => a.name.localeCompare(b.name));
		} catch (error) {
			console.error("Failed to load custom providers:", error);
			this.error = i18n("Failed to load custom providers");
		}
	}

	getTabName(): string {
		return i18n("Custom Models");
	}

	private startAdd(preset?: (typeof WANQING_PRESETS)[number]) {
		this.testResult = null;
		this.error = null;
		this.editor = {
			id: null,
			name: preset?.name || "",
			type: preset?.type || "openai-completions",
			baseUrl: preset?.baseUrl || "",
			apiKey: "",
			existingKey: false,
			models: [emptyRow()],
		};
	}

	private startEdit(record: ProviderRecord) {
		this.testResult = null;
		this.error = null;
		this.editor = {
			id: record.id,
			name: record.name,
			type: record.type,
			baseUrl: record.baseUrl,
			apiKey: "",
			existingKey: true,
			models: record.models.map((m) => ({
				id: m.id,
				name: m.name,
				contextWindow: m.contextWindow,
				maxTokens: m.maxTokens,
				reasoning: !!m.reasoning,
				inputImage: Array.isArray(m.input) && m.input.includes("image"),
			})),
		};
	}

	private setName(value: string) {
		if (this.editor) this.editor.name = value;
	}

	private setType(value: string) {
		if (this.editor) this.editor.type = value as ProviderType;
	}

	private setBaseUrl(value: string) {
		if (this.editor) this.editor.baseUrl = value;
	}

	private setApiKey(value: string) {
		if (this.editor) this.editor.apiKey = value;
	}

	private applyPreset(preset: (typeof WANQING_PRESETS)[number]) {
		if (!this.editor) return;
		this.editor = { ...this.editor, name: preset.name, type: preset.type, baseUrl: preset.baseUrl };
	}

	private setModelField(index: number, patch: Partial<ModelRow>) {
		if (!this.editor) return;
		this.editor.models = this.editor.models.map((row, i) => (i === index ? { ...row, ...patch } : row));
	}

	private addModelRow() {
		if (this.editor) this.editor.models = [...this.editor.models, emptyRow()];
	}

	private removeModelRow(index: number) {
		if (this.editor) this.editor.models = this.editor.models.filter((_, i) => i !== index);
	}

	private async save() {
		if (!this.editor) return;
		if (!this.editor.name.trim() || !this.editor.baseUrl.trim()) {
			this.error = i18n("Name and base URL are required");
			return;
		}
		const validModels = this.editor.models.filter((row) => row.id.trim().length > 0);
		if (validModels.length === 0) {
			this.error = i18n("Add at least one model with an id");
			return;
		}
		try {
			const storage = getSitegeistStorage();
			const record = recordFromEditor(this.editor, () => crypto.randomUUID());
			await storage.customProviders.set(record);
			if (this.editor.apiKey.trim()) {
				await storage.providerKeys.set(record.id, this.editor.apiKey.trim());
			}
			this.editor = null;
			await this.reload();
		} catch (error) {
			console.error("Failed to save custom provider:", error);
			this.error = i18n("Failed to save provider");
		}
	}

	private async removeProvider(id: string) {
		if (!window.confirm(i18n("Delete this provider and its key?"))) return;
		try {
			const storage = getSitegeistStorage();
			await storage.customProviders.delete(id);
			await storage.providerKeys.delete(id);
			await this.reload();
		} catch (error) {
			console.error("Failed to delete custom provider:", error);
		}
	}

	private async runTest() {
		if (!this.editor) return;
		const firstModel = this.editor.models.find((row) => row.id.trim().length > 0);
		this.testing = true;
		this.testResult = null;
		try {
			this.testResult = await testConnection(
				this.editor.type,
				this.editor.baseUrl,
				this.editor.apiKey,
				firstModel ? firstModel.id.trim() : "",
			);
		} finally {
			this.testing = false;
		}
	}

	private renderModelRow(row: ModelRow, index: number): TemplateResult {
		return html`
			<div class="flex flex-col gap-1 p-2 rounded-md border border-border">
				<div class="grid grid-cols-12 gap-2 items-center">
					<input
						class="col-span-4 px-2 py-1.5 rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary"
						placeholder=${i18n("model id (ep-xxx / gpt-...)")}
						.value=${row.id}
						@input=${(e: Event) => this.setModelField(index, { id: (e.target as HTMLInputElement).value })}
					/>
					<input
						class="col-span-3 px-2 py-1.5 rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary"
						placeholder=${i18n("display name")}
						.value=${row.name}
						@input=${(e: Event) => this.setModelField(index, { name: (e.target as HTMLInputElement).value })}
					/>
					<input
						class="col-span-2 px-2 py-1.5 rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary"
						placeholder=${i18n("context")}
						.value=${String(row.contextWindow)}
						@input=${(e: Event) => this.setModelField(index, { contextWindow: Number((e.target as HTMLInputElement).value) || 0 })}
					/>
					<input
						class="col-span-2 px-2 py-1.5 rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary"
						placeholder=${i18n("max out")}
						.value=${String(row.maxTokens)}
						@input=${(e: Event) => this.setModelField(index, { maxTokens: Number((e.target as HTMLInputElement).value) || 0 })}
					/>
					<button
						class="col-span-1 text-xs text-destructive hover:underline"
						@click=${() => this.removeModelRow(index)}
					>
						${i18n("del")}
					</button>
				</div>
				<div class="flex items-center gap-4 text-xs text-muted-foreground">
					<label class="flex items-center gap-1">
						<input
							type="checkbox"
							.checked=${row.reasoning}
							@change=${(e: Event) => this.setModelField(index, { reasoning: (e.target as HTMLInputElement).checked })}
						/>
						${i18n("reasoning")}
					</label>
					<label class="flex items-center gap-1">
						<input
							type="checkbox"
							.checked=${row.inputImage}
							@change=${(e: Event) => this.setModelField(index, { inputImage: (e.target as HTMLInputElement).checked })}
						/>
						${i18n("image input")}
					</label>
				</div>
			</div>
		`;
	}

	private renderEditor(): TemplateResult {
		const editor = this.editor!;
		return html`
			<div class="flex flex-col gap-3 p-4 rounded-lg border border-border bg-card">
				<div class="flex items-center justify-between">
					<h3 class="text-sm font-semibold text-foreground">${editor.id ? i18n("Edit provider") : i18n("Add provider")}</h3>
					<div class="flex gap-2">
						${WANQING_PRESETS.map(
							(preset, index) => html`
								<button
									class="text-xs px-2 py-1 rounded border border-border text-foreground hover:bg-muted"
									@click=${() => this.applyPreset(preset)}
								>
									${i18n("Wanqing preset")} ${index + 1}
								</button>
							`,
						)}
					</div>
				</div>

				${Label({ children: i18n("Name") })}
				${Input({
					type: "text",
					value: editor.name,
					placeholder: "Wanqing (Kuaishou)",
					onInput: (e) => this.setName((e.target as HTMLInputElement).value),
				})}

				${Label({ children: i18n("API type") })}
				<select
					class="w-full px-3 py-2 rounded-md border border-border bg-card text-sm text-foreground"
					@change=${(e: Event) => this.setType((e.target as HTMLSelectElement).value)}
				>
					<option value="openai-completions" ?selected=${editor.type === "openai-completions"}>OpenAI-compatible (chat/completions)</option>
					<option value="openai-responses" ?selected=${editor.type === "openai-responses"}>OpenAI Responses</option>
					<option value="anthropic-messages" ?selected=${editor.type === "anthropic-messages"}>Anthropic Messages</option>
				</select>

				${Label({ children: i18n("Base URL") })}
				${Input({
					type: "text",
					value: editor.baseUrl,
					placeholder: "https://...",
					onInput: (e) => this.setBaseUrl((e.target as HTMLInputElement).value),
				})}

				${Label({ children: editor.existingKey ? i18n("API key (saved — leave empty to keep)") : i18n("API key") })}
				${Input({
					type: "password",
					value: editor.apiKey,
					placeholder: editor.existingKey ? "........" : "sk-...",
					onInput: (e) => this.setApiKey((e.target as HTMLInputElement).value),
				})}

				<div class="flex items-center gap-2">
					${Button({
						variant: "outline",
						size: "sm",
						disabled: this.testing,
						loading: this.testing,
						onClick: () => this.runTest(),
						children: this.testing ? i18n("Testing...") : i18n("Test connection"),
					})}
					${this.testResult ? html`<span class="text-xs text-muted-foreground">${this.testResult}</span>` : ""}
				</div>

				<div class="flex items-center justify-between mt-1">
					<h4 class="text-sm font-semibold text-foreground">${i18n("Models")}</h4>
					<button
						class="text-xs px-2 py-1 rounded border border-border text-foreground hover:bg-muted"
						@click=${() => this.addModelRow()}
					>
						${i18n("+ Add model")}
					</button>
				</div>
				<div class="flex flex-col gap-2">
					${editor.models.map((row, index) => this.renderModelRow(row, index))}
				</div>

				${this.error ? html`<div class="text-xs text-destructive">${this.error}</div>` : ""}

				<div class="flex gap-2 justify-end mt-2">
					${Button({
						variant: "outline",
						size: "sm",
						onClick: () => {
							this.editor = null;
						},
						children: i18n("Cancel"),
					})}
					${Button({ variant: "default", size: "sm", onClick: () => this.save(), children: i18n("Save provider") })}
				</div>
			</div>
		`;
	}

	private renderProviderRow(record: ProviderRecord): TemplateResult {
		return html`
			<div class="flex items-center justify-between p-4 rounded-lg border border-border bg-card">
				<div class="flex-1 min-w-0">
					<div class="text-sm font-medium text-foreground">${record.name}</div>
					<div class="text-xs text-muted-foreground mt-1 truncate">
						<span class="capitalize">${record.type}</span> • ${record.baseUrl} • ${record.models.length} ${i18n("models")}
					</div>
					<div class="text-xs text-muted-foreground mt-0.5 truncate">
						${record.models.map((m) => m.id).join(", ")}
					</div>
				</div>
				<div class="flex gap-2 ml-3 shrink-0">
					<button class="text-xs px-2 py-1 rounded border border-border text-foreground hover:bg-muted" @click=${() => this.startEdit(record)}>
						${i18n("Edit")}
					</button>
					<button
						class="text-xs px-2 py-1 rounded border border-destructive text-destructive hover:bg-muted"
						@click=${() => this.removeProvider(record.id)}
					>
						${i18n("Delete")}
					</button>
				</div>
			</div>
		`;
	}

	render(): TemplateResult {
		return html`
			<div class="flex flex-col gap-4">
				<p class="text-sm text-muted-foreground">
					${i18n(
						"Configure custom model providers (Wanqing gateway, self-hosted proxies). Saved models appear in the model selector; the API key is stored separately and used when sending.",
					)}
				</p>

				${this.editor ? this.renderEditor() : ""}

				${
					this.editor
						? ""
						: html`
							<div class="flex flex-col gap-3">
								<div class="flex flex-wrap gap-2">
									${Button({ variant: "default", size: "sm", onClick: () => this.startAdd(), children: i18n("+ Add provider") })}
									${Button({
										variant: "outline",
										size: "sm",
										onClick: () => this.startAdd(WANQING_PRESETS[0]),
										children: i18n("+ Wanqing OpenAI"),
									})}
									${Button({
										variant: "outline",
										size: "sm",
										onClick: () => this.startAdd(WANQING_PRESETS[1]),
										children: i18n("+ Wanqing Anthropic"),
									})}
								</div>
								${
									this.providers.length === 0
										? html`<p class="text-xs text-muted-foreground">${i18n("No custom providers configured.")}</p>`
										: this.providers.map((record) => this.renderProviderRow(record))
								}
							</div>
						`
				}
			</div>
		`;
	}
}
