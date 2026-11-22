import { WorkspaceLeaf, type App, type OpenViewState, type TFile } from "obsidian";
import { boardFormat, identifyBoard } from "./formats";
import { VIEW_TYPE } from "./view";

export function routeBoardFiles(app: App, isDraft: (file: TFile) => boolean): () => void {
  const pending = new WeakMap<WorkspaceLeaf, object>();
  let installed = true;
  const prototype = WorkspaceLeaf.prototype;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Restore the exact method and invoke it with its original receiver.
  const original = prototype.openFile;
  // Intercept before Obsidian chooses a view by extension or opens JSON externally.
  async function openFile(this: WorkspaceLeaf, file: TFile, options?: OpenViewState): Promise<void> {
    if (!installed || this.view.app !== app) return original.call(this, file, options);
    const request = {};
    pending.set(this, request);

    const format = file && boardFormat(file.extension);
    // Links targeting a specific Markdown heading or block still navigate in the note.
    if (!format || isDraft(file) || (format === "md" && options?.eState?.subpath)) {
      return original.call(this, file, options);
    }
    const cache = format === "md" ? app.metadataCache.getFileCache(file) : undefined;
    if (cache && cache.frontmatter?.type !== "task-board") return original.call(this, file, options);

    const previous = this.getViewState();
    if (!cache) {
      let isBoard = false;
      try {
        isBoard = identifyBoard(await app.vault.cachedRead(file), format) !== null;
      } catch {
        // Leave unreadable files to Obsidian's normal handling.
      }
      const current = this.getViewState();
      if (pending.get(this) !== request || current.type !== previous.type ||
        current.state?.file !== previous.state?.file) return;
      if (!installed || !isBoard) return original.call(this, file, options);
    }

    const preferences = previous.type === VIEW_TYPE ? previous.state : undefined;
    await this.setViewState({
      type: VIEW_TYPE,
      state: { ...preferences, file: file.path },
      active: options?.active ?? app.workspace.getMostRecentLeaf() === this,
      group: options?.group,
    }, options?.eState);
  }

  prototype.openFile = openFile;
  return () => {
    // A wrapper installed later can keep calling ours after unload.
    installed = false;
    if (prototype.openFile === openFile) prototype.openFile = original;
  };
}
