// The dialogs the screens ask of the shell, with no platform in them (they are nav.ts's, which re-exports them): a question, and an error the user should see.
import { setState, type ConfirmRequest } from "@aiwb/core/state/store.ts";

export function confirm(req: ConfirmRequest): void { setState({ confirm: req }); }

/** Shows an error the user should see, in the confirm dialog with only a Close button. */
export function reportError(title: string, err: unknown): void {
  confirm({ title, body: err instanceof Error ? err.message : String(err), actions: [] });
}

/** Runs `f`; a failure is shown as `title` with the error's sentence. */
export const attempt = (title: string, f: () => Promise<unknown>): void => { f().catch((e) => reportError(title, e)); };
