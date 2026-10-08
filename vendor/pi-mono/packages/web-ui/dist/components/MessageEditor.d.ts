import type { Model } from "@mariozechner/pi-ai";
import { LitElement } from "lit";
import { type Attachment } from "../utils/attachment-utils.js";
import "./AttachmentTile.js";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
/**
 * A single entry in the slash-command suggestion menu.
 */
export interface EditorSuggestion {
    /** Primary text shown in the menu (e.g. "/compact" or a skill name). */
    label: string;
    /** Secondary hint text. */
    description?: string;
    /** Text written into the editor when the suggestion is selected. */
    insertText: string;
}
export declare class MessageEditor extends LitElement {
    private _value;
    private textareaRef;
    get value(): string;
    set value(val: string);
    isStreaming: boolean;
    currentModel?: Model<any>;
    thinkingLevel: ThinkingLevel;
    showAttachmentButton: boolean;
    showModelSelector: boolean;
    showThinkingSelector: boolean;
    onInput?: (value: string) => void;
    onSend?: (input: string, attachments: Attachment[]) => void;
    onAbort?: () => void;
    onModelSelect?: () => void;
    onThinkingChange?: (level: "off" | "minimal" | "low" | "medium" | "high") => void;
    onFilesChange?: (files: Attachment[]) => void;
    /**
     * Suggestion provider for slash-command style menus. Called with the text
     * after the leading "/" while the input is a single "/word" token.
     */
    suggestionProvider?: (query: string) => EditorSuggestion[] | Promise<EditorSuggestion[]>;
    attachments: Attachment[];
    maxFiles: number;
    maxFileSize: number;
    acceptedTypes: string;
    processingFiles: boolean;
    isDragging: boolean;
    private suggestions;
    private selectedSuggestion;
    private suggestionToken;
    private fileInputRef;
    protected createRenderRoot(): HTMLElement | DocumentFragment;
    private handleTextareaInput;
    private updateSuggestions;
    private applySuggestion;
    private handleSuggestionBlur;
    private handleKeyDown;
    private handlePaste;
    private handleSend;
    private handleAttachmentClick;
    private handleFilesSelected;
    private removeFile;
    private handleDragOver;
    private handleDragLeave;
    private handleDrop;
    firstUpdated(): void;
    render(): import("lit-html").TemplateResult<1>;
}
//# sourceMappingURL=MessageEditor.d.ts.map