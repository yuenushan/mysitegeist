import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { getSitegeistStorage } from "../storage/app-storage.js";

// ---------------------------------------------------------------------------
// Provider catalog
// ---------------------------------------------------------------------------

interface ProviderInfo {
	id: string;
	name: string;
	defaultModel: string;
	keyPlaceholder: string;
	keyUrl: string;
	hint: string;
}

const PROVIDERS: ProviderInfo[] = [
	{
		id: "anthropic",
		name: "Anthropic",
		defaultModel: "claude-sonnet-4-6",
		keyPlaceholder: "sk-ant-...",
		keyUrl: "https://console.anthropic.com/settings/keys",
		hint: "Claude 系列模型。支持订阅登录或 API key。",
	},
	{
		id: "openai",
		name: "OpenAI",
		defaultModel: "gpt-4o",
		keyPlaceholder: "sk-...",
		keyUrl: "https://platform.openai.com/api-keys",
		hint: "GPT 系列模型。",
	},
	{
		id: "google",
		name: "Google Gemini",
		defaultModel: "gemini-2.5-flash",
		keyPlaceholder: "AIza...",
		keyUrl: "https://aistudio.google.com/apikey",
		hint: "Gemini 系列，免费额度较大。",
	},
	{
		id: "openrouter",
		name: "OpenRouter",
		defaultModel: "openai/gpt-5.1-codex",
		keyPlaceholder: "sk-or-...",
		keyUrl: "https://openrouter.ai/keys",
		hint: "一个 key 访问多家模型（Claude / GPT / Gemini / 开源）。",
	},
	{
		id: "custom",
		name: "Custom / 自建代理",
		defaultModel: "",
		keyPlaceholder: "your-api-key",
		keyUrl: "",
		hint: "自定义 base URL + API key（内部代理 / 中转站）。",
	},
];

// ---------------------------------------------------------------------------
// Wizard state
// ---------------------------------------------------------------------------

type Step = "welcome" | "provider" | "apikey" | "verify" | "permissions" | "done";

@customElement("setup-wizard-dialog")
export class SetupWizard extends DialogBase {
	@state() private step: Step = "welcome";
	@state() private provider: string | null = null;
	@state() private apiKey = "";
	@state() private baseUrl = "";
	@state() private model = "";
	@state() private testing = false;
	@state() private testResult: "ok" | "fail" | null = null;
	@state() private testMessage = "";

	private resolvePromise: ((configured: boolean) => void) | null = null;
	protected modalWidth = "min(520px, 92vw)";
	protected modalHeight = "auto";

	static show(): Promise<boolean> {
		return new Promise((resolve) => {
			const dialog = new SetupWizard();
			dialog.resolvePromise = resolve;
			dialog.open();
		});
	}

	override close() {
		super.close();
		this.resolvePromise?.(this.step === "done");
	}

	private get providerInfo(): ProviderInfo | undefined {
		return PROVIDERS.find((p) => p.id === this.provider);
	}

	private go(step: Step) {
		this.step = step;
	}

	private async saveAndContinue() {
		if (!this.provider || !this.apiKey) return;
		const storage = getSitegeistStorage();
		await storage.providerKeys.set(this.provider, this.apiKey);
		if (this.baseUrl && this.provider === "custom") {
			await storage.settings.set("customProvider.baseUrl." + this.provider, this.baseUrl);
		}
		this.go("verify");
	}

	private async testKey() {
		this.testing = true;
		this.testResult = null;
		this.testMessage = "";
		try {
			const provider = this.provider;
			if (!provider) return;
			const info = this.providerInfo;
			if (!info) return;
			// simple provider-specific test call
			let url = "";
			let init: RequestInit = {};
			if (provider === "anthropic") {
				url = "https://api.anthropic.com/v1/messages";
				init = {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"x-api-key": this.apiKey,
						"anthropic-version": "2023-06-01",
					},
					body: JSON.stringify({
						model: "claude-sonnet-4-6",
						max_tokens: 1,
						messages: [{ role: "user", content: "hi" }],
					}),
				};
			} else if (provider === "openai" || provider === "custom") {
				const base = this.baseUrl || (provider === "openai" ? "https://api.openai.com" : "");
				url = (base || "https://api.openai.com") + "/v1/models";
				init = { headers: { Authorization: "Bearer " + this.apiKey } };
			} else if (provider === "google") {
				url = "https://generativelanguage.googleapis.com/v1beta/models?key=" + this.apiKey;
			} else if (provider === "openrouter") {
				url = "https://openrouter.ai/api/v1/models";
				init = { headers: { Authorization: "Bearer " + this.apiKey } };
			}
			if (!url) {
				this.testResult = "ok";
				return;
			}
			const r = await fetch(url, init);
			if (r.ok) {
				this.testResult = "ok";
				this.testMessage = "Key 验证通过";
			} else {
				const body = await r.text().catch(() => "");
				this.testResult = "fail";
				this.testMessage = `HTTP ${r.status}: ${body.slice(0, 150)}`;
			}
		} catch (e) {
			this.testResult = "fail";
			this.testMessage = e instanceof Error ? e.message.slice(0, 150) : String(e).slice(0, 150);
		} finally {
			this.testing = false;
		}
	}

	protected renderContent() {
		return html`
			<div class="flex flex-col gap-5">
				<!-- progress indicator -->
				${this.renderProgress()}
				<!-- step content -->
				${this.step === "welcome" ? this.renderWelcome() : nothing}
				${this.step === "provider" ? this.renderProvider() : nothing}
				${this.step === "apikey" ? this.renderApiKey() : nothing}
				${this.step === "verify" ? this.renderVerify() : nothing}
				${this.step === "permissions" ? this.renderPermissions() : nothing}
				${this.step === "done" ? this.renderDone() : nothing}
			</div>
		`;
	}

	private renderProgress() {
		const steps: { key: Step; label: string }[] = [
			{ key: "welcome", label: "开始" },
			{ key: "provider", label: "选择" },
			{ key: "apikey", label: "密钥" },
			{ key: "verify", label: "验证" },
			{ key: "permissions", label: "权限" },
			{ key: "done", label: "完成" },
		];
		const currentIdx = steps.findIndex((s) => s.key === this.step);
		return html`
			<div class="flex items-center gap-1.5 text-xs">
				${steps.map(
					(s, i) => html`
					${i > 0 ? html`<span class=${i <= currentIdx ? "text-foreground" : "text-muted-foreground/40"}>→</span>` : nothing}
					<span class=${i < currentIdx ? "text-muted-foreground" : i === currentIdx ? "text-foreground font-semibold" : "text-muted-foreground/50"}>
						${s.label}
					</span>
				`,
				)}
			</div>
		`;
	}

	private renderWelcome() {
		return html`
			<div class="flex flex-col gap-4">
				<div>
					<h2 class="text-lg font-semibold text-foreground">欢迎使用 Sitegeist</h2>
					<p class="text-sm text-muted-foreground mt-1">
						浏览器里的 AI 助手——可以操作网页、查询数据、自动化重复任务。
					</p>
				</div>
				<div class="rounded-lg border border-border bg-card p-3 space-y-2 text-sm">
					<p class="font-medium text-foreground">接下来我们会配置：</p>
					<ol class="list-decimal list-inside text-muted-foreground space-y-1">
						<li>选择一个 AI 服务商</li>
						<li>填入 API key（带验证）</li>
						<li>确认 Chrome 权限</li>
					</ol>
					<p class="text-xs text-muted-foreground">全程约 1 分钟。所有数据只存在本地浏览器。</p>
				</div>
				<div class="flex justify-end">
					${Button({ variant: "default", onClick: () => this.go("provider"), children: "开始 →" })}
				</div>
			</div>
		`;
	}

	private renderProvider() {
		return html`
			<div class="flex flex-col gap-4">
				<div>
					<h2 class="text-base font-semibold text-foreground">选择 AI 服务商</h2>
					<p class="text-xs text-muted-foreground mt-1">选一个你有账号或 API key 的。不确定就选 OpenRouter（一个 key 多家模型）。</p>
				</div>
				<div class="grid grid-cols-1 gap-2">
					${PROVIDERS.map(
						(p) => html`
							<button
								class="flex items-center gap-3 p-3 rounded-lg border text-left transition-colors cursor-pointer
									${this.provider === p.id ? "border-primary bg-primary/5" : "border-border hover:border-foreground/30"}"
								@click=${() => {
									this.provider = p.id;
								}}
							>
								<div class="flex-1">
									<div class="text-sm font-medium text-foreground">${p.name}</div>
									<div class="text-xs text-muted-foreground">${p.hint}</div>
								</div>
								${this.provider === p.id ? html`<span class="text-primary text-sm">✓</span>` : nothing}
							</button>
						`,
					)}
				</div>
				<div class="flex justify-between">
					${Button({ variant: "outline", onClick: () => this.go("welcome"), children: "← 上一步" })}
					${Button({ variant: "default", onClick: () => this.go("apikey"), children: "下一步 →", disabled: !this.provider })}
				</div>
			</div>
		`;
	}

	private renderApiKey() {
		const info = this.providerInfo;
		if (!info) return nothing;
		return html`
			<div class="flex flex-col gap-4">
				<div>
					<h2 class="text-base font-semibold text-foreground">${info.name} — API Key</h2>
					${
						info.keyUrl
							? html`<p class="text-xs text-muted-foreground mt-1">
								没有 key？
								<a href="${info.keyUrl}" target="_blank" class="text-primary underline underline-offset-2">
									去 ${info.name} 控制台获取 →
								</a>
							</p>`
							: nothing
					}
				</div>
				<div class="space-y-3">
					${Input({
						type: "password",
						value: this.apiKey,
						placeholder: info.keyPlaceholder,
						onInput: (e: Event) => {
							this.apiKey = (e.target as HTMLInputElement).value;
						},
						className: "w-full font-mono text-sm",
					})}
					${
						this.provider === "custom"
							? html`
							<div class="space-y-1">
								<label class="text-xs text-muted-foreground">Base URL（内部代理 / 中转站地址）</label>
								${Input({
									type: "text",
									value: this.baseUrl,
									placeholder: "https://your-proxy.example.com",
									onInput: (e: Event) => {
										this.baseUrl = (e.target as HTMLInputElement).value;
									},
									className: "w-full font-mono text-sm",
								})}
							</div>
						`
							: nothing
					}
					<div class="flex gap-2">
						${Button({
							variant: "outline",
							size: "sm",
							onClick: () => this.testKey(),
							children: this.testing ? "验证中…" : "测试 Key",
							disabled: !this.apiKey || this.testing,
						})}
					</div>
					${
						this.testResult === "ok"
							? html`<p class="text-sm text-green-600">✓ Key 验证通过</p>`
							: this.testResult === "fail"
								? html`<p class="text-sm text-destructive">✗ ${this.testMessage}</p>`
								: nothing
					}
				</div>
				<div class="flex justify-between">
					${Button({ variant: "outline", onClick: () => this.go("provider"), children: "← 上一步" })}
					${Button({
						variant: "default",
						onClick: () => this.saveAndContinue(),
						children: "保存并继续 →",
						disabled: !this.apiKey,
					})}
				</div>
			</div>
		`;
	}

	private renderVerify() {
		const info = this.providerInfo;
		return html`
			<div class="flex flex-col gap-4">
				<div>
					<h2 class="text-base font-semibold text-foreground">✓ 已保存</h2>
					<p class="text-sm text-muted-foreground mt-1">
						${info?.name || this.provider} 的 key 已存入本地。agent 现在可以调用了。
					</p>
				</div>
				<div class="rounded-lg border border-border bg-card p-3 text-sm text-muted-foreground">
					<p>下一步是确认 Chrome 权限。Sitegeist 需要在网页上运行脚本来提供自动化能力——你需要在 chrome://extensions 里开启 "Allow user scripts"。</p>
				</div>
				<div class="flex justify-between">
					${Button({ variant: "outline", onClick: () => this.go("apikey"), children: "← 上一步" })}
					${Button({ variant: "default", onClick: () => this.go("permissions"), children: "下一步 →" })}
				</div>
			</div>
		`;
	}

	private renderPermissions() {
		return html`
			<div class="flex flex-col gap-4">
				<div>
					<h2 class="text-base font-semibold text-foreground">Chrome 权限确认</h2>
					<p class="text-sm text-muted-foreground mt-1">
						Sitegeist 需要两个 Chrome 权限。下面每项点一次链接，在 Chrome 设置里打开开关即可。
					</p>
				</div>
				<div class="rounded-lg border border-border bg-card p-3 space-y-3 text-sm">
					<div>
						<p class="font-medium text-foreground">1. Allow user scripts</p>
						<p class="text-xs text-muted-foreground">让 agent 在网页上执行 JavaScript。</p>
						<a href="chrome://extensions/?id=${chrome.runtime.id}" target="_blank" class="text-primary text-xs underline underline-offset-2">
							打开 chrome://extensions → 找到 Sitegeist → 开启 "Allow user scripts" →
						</a>
					</div>
					<div>
						<p class="font-medium text-foreground">2. Allow access to file URLs</p>
						<p class="text-xs text-muted-foreground">让 agent 能读取本地文件（可选但推荐）。</p>
						<a href="chrome://extensions/?id=${chrome.runtime.id}" target="_blank" class="text-primary text-xs underline underline-offset-2">
							同一个页面 → 开启 "Allow access to file URLs" →
						</a>
					</div>
				</div>
				<p class="text-xs text-muted-foreground">开完后回来点"完成"。这些是 Chrome 安全设置，Sitegeist 无法替你打开。</p>
				<div class="flex justify-end">
					${Button({ variant: "default", onClick: () => this.go("done"), children: "完成 →" })}
				</div>
			</div>
		`;
	}

	private renderDone() {
		return html`
			<div class="flex flex-col gap-4">
				<div class="text-center py-4">
					<div class="text-3xl">🎉</div>
					<h2 class="text-lg font-semibold text-foreground mt-2">设置完成</h2>
					<p class="text-sm text-muted-foreground mt-1">
						${this.providerInfo?.name || this.provider} 已配置，agent 可以工作了。
					</p>
				</div>
				<div class="rounded-lg border border-border bg-card p-3 text-sm text-muted-foreground space-y-1">
					<p>• 关闭这个面板再重新打开（或刷新页面），agent 就能开始工作</p>
					<p>• 在聊天框里输入任何指令试试</p>
					<p>• 高级选项（MCP 桥、skill 网络访问等）在 Settings 里</p>
				</div>
				<div class="flex justify-center">
					${Button({
						variant: "default",
						size: "lg",
						onClick: () => this.close(),
						children: "开始使用 →",
					})}
				</div>
			</div>
		`;
	}
}

if (!customElements.get("setup-wizard-dialog")) {
	customElements.define("setup-wizard-dialog", SetupWizard);
}
