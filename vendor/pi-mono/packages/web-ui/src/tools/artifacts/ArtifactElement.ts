import { LitElement, type TemplateResult } from "lit";

/** Content handed to an external viewer (e.g. a full browser tab). */
export interface ArtifactExternalContent {
	content: string | Uint8Array;
	mimeType: string;
}

export abstract class ArtifactElement extends LitElement {
	public filename = "";

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this; // light DOM for shared styles
	}

	public abstract get content(): string;
	public abstract set content(value: string);

	abstract getHeaderButtons(): TemplateResult | HTMLElement;

	/**
	 * Content suitable for opening in a full browser tab (standalone, without
	 * the runtime bridge). Return null when the file type cannot be rendered
	 * natively by the browser. Artifacts without external view support simply
	 * do not implement it.
	 */
	public getExternalViewContent?(): ArtifactExternalContent | null;
}
