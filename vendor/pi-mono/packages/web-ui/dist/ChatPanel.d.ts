import { LitElement } from "lit";
import "./components/AgentInterface.js";
import type { Agent, AgentTool } from "@mariozechner/pi-agent-core";
import type { AgentInterface } from "./components/AgentInterface.js";
import type { EditorSuggestion } from "./components/MessageEditor.js";
import type { SandboxRuntimeProvider } from "./components/sandbox/SandboxRuntimeProvider.js";
import { ArtifactsPanel, type ArtifactExternalContent } from "./tools/artifacts/index.js";
export declare class ChatPanel extends LitElement {
    agent?: Agent;
    agentInterface?: AgentInterface;
    artifactsPanel?: ArtifactsPanel;
    private hasArtifacts;
    private artifactCount;
    private showArtifactsPanel;
    private windowWidth;
    private resizeHandler;
    createRenderRoot(): this;
    connectedCallback(): void;
    disconnectedCallback(): void;
    setAgent(agent: Agent, config?: {
        onApiKeyRequired?: (provider: string) => Promise<boolean>;
        onBeforeSend?: (input: string) => void | boolean | Promise<void | boolean>;
        suggestionProvider?: (query: string) => EditorSuggestion[] | Promise<EditorSuggestion[]>;
        onCostClick?: () => void;
        onModelSelect?: () => void;
        sandboxUrlProvider?: () => string;
        artifactsOpenExternal?: (filename: string, external: ArtifactExternalContent) => void;
        toolsFactory?: (agent: Agent, agentInterface: AgentInterface, artifactsPanel: ArtifactsPanel, runtimeProvidersFactory: () => SandboxRuntimeProvider[]) => AgentTool<any>[];
    }): Promise<void>;
    render(): import("lit-html").TemplateResult<1>;
}
//# sourceMappingURL=ChatPanel.d.ts.map