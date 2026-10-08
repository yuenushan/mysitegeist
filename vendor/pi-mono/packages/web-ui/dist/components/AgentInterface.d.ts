import { LitElement, type TemplateResult } from "lit";
import type { EditorSuggestion } from "./MessageEditor.js";
import "./MessageEditor.js";
import "./MessageList.js";
import "./Messages.js";
import "./StreamingMessageContainer.js";
import type { Agent } from "@mariozechner/pi-agent-core";
import type { Attachment } from "../utils/attachment-utils.js";
export declare class AgentInterface extends LitElement {
    session?: Agent;
    enableAttachments: boolean;
    enableModelSelector: boolean;
    enableThinkingSelector: boolean;
    showThemeToggle: boolean;
    onApiKeyRequired?: (provider: string) => Promise<boolean>;
    onBeforeSend?: (input: string) => void | boolean | Promise<void | boolean>;
    suggestionProvider?: (query: string) => EditorSuggestion[] | Promise<EditorSuggestion[]>;
    onBeforeToolCall?: (toolName: string, args: any) => boolean | Promise<boolean>;
    onCostClick?: () => void;
    onModelSelect?: () => void;
    private _messageEditor;
    private _streamingContainer;
    private _autoScroll;
    private _lastScrollTop;
    private _lastClientHeight;
    private _scrollContainer?;
    private _resizeObserver?;
    private _unsubscribeSession?;
    setInput(text: string, attachments?: Attachment[]): void;
    setAutoScroll(enabled: boolean): void;
    protected createRenderRoot(): HTMLElement | DocumentFragment;
    willUpdate(changedProperties: Map<string, any>): void;
    connectedCallback(): Promise<void>;
    disconnectedCallback(): void;
    private setupSessionSubscription;
    private _handleScroll;
    sendMessage(input: string, attachments?: Attachment[]): Promise<void>;
    /**
     * Optional transient block rendered at the end of the message list
     * (e.g. a live compaction preview). Rendered as-is; the host clears it
     * when done. Not persisted, not part of agent state.
     */
    transientContent: TemplateResult | null;
    /**
     * Display order for the message list. Compaction messages sit at index 0
     * of the model context (summary prepended for the LLM), but their
     * chronological position is after the retained tail they summarize.
     * Displaying them at the top hides them behind thousands of pixels of
     * tail content; instead insert each after the last message that predates
     * it (pi's TUI does the same: summary card appended below the tail).
     */
    private displayMessages;
    private renderMessages;
    private renderStats;
    render(): TemplateResult<1>;
}
//# sourceMappingURL=AgentInterface.d.ts.map