import i18n from "@mariozechner/mini-lit/dist/i18n.js";
import { customElement } from "lit/decorators.js";
import { PermissionDialog } from "./PermissionDialog.js";

interface ConfirmActionInfo {
	/** Dialog title, e.g. "Uninstall extension" (i18n-resolved at the call site). */
	title: string;
	/** First bullet line identifying the subject, e.g. "Extension: Foo (id abc)". */
	subjectLine: string;
	/** One-line consequence shown in the bullet list. */
	consequence: string;
}

/**
 * Gesture-context confirmation for agent-initiated extension management
 * actions. chrome.management.setEnabled and chrome.management.uninstall must
 * run inside a real user click handler; this dialog provides that click.
 * The callback passed to requestPermission is invoked synchronously in the
 * click handler, so the chrome.management call carries the user gesture.
 */
@customElement("confirm-action-dialog")
export class ConfirmActionDialog extends PermissionDialog {
	private info!: ConfirmActionInfo;

	static async request(
		info: ConfirmActionInfo,
		perform: () => Promise<{ ok: boolean; message?: string }>,
	): Promise<boolean> {
		const dialog = new ConfirmActionDialog();
		dialog.info = info;
		return dialog.requestPermission(async () => {
			const result = await perform();
			return { granted: result.ok, message: result.message };
		});
	}

	protected header() {
		return {
			title: this.info.title,
			description: i18n("Sitegeist's agent wants to perform this action and needs your confirmation."),
		};
	}

	protected why(): string {
		return i18n(
			"Chrome requires this action to be triggered by a real user click. Confirming here provides that click; nothing happens if you cancel.",
		);
	}

	protected what(): string[] {
		return [this.info.subjectLine, this.info.consequence];
	}

	protected override denyLabel(): string {
		return i18n("Cancel");
	}

	protected override confirmLabel(): string {
		return i18n("Confirm");
	}
}
