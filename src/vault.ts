import { t } from "./i18n";
import { MarkdownView, type App, type TFile } from "obsidian";
import type { Mutation } from "./board";
import { boardFormat, identifyBoard, parseBoard, serializeBoard } from "./formats";

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function openMarkdownOriginal(app: App, file: TFile): Promise<void> {
  return app.workspace.getLeaf("tab").setViewState({
    type: "markdown",
    state: { file: file.path, mode: "source" },
    active: true,
  });
}

export function normalizeMarkdown(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export async function discoverBoards(app: App) {
  const boards: { file: TFile; title?: string; id?: string }[] = [];
  const files = app.vault.getFiles().filter((file) => {
    const format = boardFormat(file.extension);
    if (format !== "md") return format === "json";
    const cache = app.metadataCache.getFileCache(file);
    return !cache || cache.frontmatter?.type === "task-board";
  });
  // Bound concurrent reads in large vaults.
  for (let index = 0; index < files.length; index += 24) {
    await Promise.all(files.slice(index, index + 24).map(async (file) => {
      const format = boardFormat(file.extension);
      if (!format) return;
      try {
        const identity = identifyBoard(await app.vault.cachedRead(file), format);
        if (identity) boards.push({ file, ...identity });
      } catch {
        // A file may disappear while the picker is being populated.
      }
    }));
  }
  return boards.sort((a, b) => a.file.path.localeCompare(b.file.path));
}

export async function changeBoard(app: App, file: TFile, id: string, mutation: Mutation): Promise<void> {
  const format = boardFormat(file.extension);
  if (!format) throw new Error(t("The board file extension changed."));
  await app.vault.process(file, (source) => {
    if (format === "md") {
      let unsaved = false;
      app.workspace.iterateAllLeaves(({ view }) => {
        if (view instanceof MarkdownView && view.file === file && view.getMode() === "source") {
          if (normalizeMarkdown(view.editor.getValue()) !== normalizeMarkdown(source)) unsaved = true;
        }
      });
      if (unsaved) throw new Error(t("The Markdown tab has unsaved changes. Wait for it to save and try again."));
    }
    const document = parseBoard(source, format);
    if (document.board.id !== id) throw new Error(t("This file now belongs to a different board."));
    mutation(document.board);
    return serializeBoard(document.board, format, document);
  });
}
