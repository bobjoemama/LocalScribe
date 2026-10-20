import type { LocalScribeApi } from "../shared/contracts";

type Preparation = {
  updates: Pick<LocalScribeApi["updates"], "onPrepareInstall" | "onInstallCancelled">;
  freeze(frozen: boolean): void;
  prepare(): boolean | Promise<boolean>;
};

/** Freeze synchronously before checking drafts or awaiting their durable writes. */
export function registerUpdatePreparation({ updates, freeze, prepare }: Preparation): () => void {
  let request: string | undefined;
  let disposed = false;
  const blockEditing = (event: Event) => {
    if (!request) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  // Inert blocks controls, while capture also stops window-level navigation
  // shortcuts and Escape from unmounting an editor during preparation.
  const blockedEvents = ["keydown", "beforeinput", "pointerdown", "click"] as const;
  for (const event of blockedEvents) window.addEventListener(event, blockEditing, true);
  const release = (requestId: string) => {
    if (request !== requestId) return;
    request = undefined;
    freeze(false);
  };
  const unsubscribeCancellation = updates.onInstallCancelled(release);
  const unsubscribePreparation = updates.onPrepareInstall(async (requestId) => {
    if (disposed || request) return false;
    request = requestId;
    freeze(true);
    try {
      const prepared = await prepare();
      if (disposed || request !== requestId) return false;
      if (!prepared) release(requestId);
      return prepared;
    } catch {
      release(requestId);
      return false;
    }
  });
  return () => {
    disposed = true;
    unsubscribePreparation();
    unsubscribeCancellation();
    for (const event of blockedEvents) window.removeEventListener(event, blockEditing, true);
    if (request) release(request);
  };
}
