import { getLocale, languageAttributes, setLocale, t } from "./i18n";
import { Notice, Plugin, SuggestModal, TFile, getLanguage, normalizePath, type App } from "obsidian";
import { createBoard } from "./board";
import { DESCRIPTION_VIEW, DescriptionEditor, DescriptionView } from "./description-editor";
import { boardFormat, identifyBoard, serializeBoard, type BoardFormat } from "./formats";
import { routeBoardFiles } from "./navigation";
import { BoardModal, button, field } from "./ui";
import { discoverBoards, errorText, openMarkdownOriginal } from "./vault";
import { BoardView, VIEW_TYPE } from "./view";

type BoardChoice = Awaited<ReturnType<typeof discoverBoards>>[number];

export default class TaskBoardPlugin extends Plugin {
  private descriptions!: DescriptionEditor;

  async onload(): Promise<void> {
    setLocale(getLanguage());
    this.manifest.description = t("View and edit tasks and subtasks in Table and Kanban views using Markdown or JSON boards.");
    this.descriptions = new DescriptionEditor(this);
    this.registerView(VIEW_TYPE, (leaf) => new BoardView(leaf, this.descriptions));
    this.registerView(DESCRIPTION_VIEW, (leaf) => new DescriptionView(leaf, this.descriptions));
    await this.descriptions.initialize();
    this.register(routeBoardFiles(this.app, (file) => this.descriptions.isDraft(file)));
    const ribbon = this.addRibbonIcon("kanban", `${this.manifest.name} — ${t("Open board")}`, () => this.report(this.pickBoard()));
    ribbon.addClass("task-board-ribbon");
    this.addCommand({
      id: "create",
      name: t("Create board"),
      callback: () => new CreateBoardModal(this.app, (file) => this.openBoard(file)).open(),
    });
    this.addCommand({
      id: "open",
      name: t("Open board"),
      callback: () => this.report(this.pickBoard()),
    });
    this.addCommand({
      id: "open-current",
      name: t("Open current file as board"),
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !boardFormat(file.extension)) return false;
        if (!checking) this.report(this.openRecognized(file));
        return true;
      },
    });
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (!(file instanceof TFile) || this.descriptions.isDraft(file)) return;
      const format = boardFormat(file.extension);
      if (!format) return;
      if (format === "md" && this.app.metadataCache.getFileCache(file)?.frontmatter?.type !== "task-board") return;
      menu.addItem((item) => item.setTitle(t("Open as board")).setIcon("kanban")
        .onClick(() => this.report(this.openRecognized(file))));
      if (format === "md") {
        menu.addItem((item) => item.setTitle(t("Open original Markdown")).setIcon("file-text")
          .onClick(() => this.report(openMarkdownOriginal(this.app, file))));
      }
    }));
    const openItemLink = (params: Record<string, string>) => {
      this.app.workspace.onLayoutReady(() => this.report(this.openLink(params)));
    };
    this.registerObsidianProtocolHandler(this.manifest.id, openItemLink);
    this.registerObsidianProtocolHandler("task-board", openItemLink);
  }

  private report(operation: Promise<void>): void {
    void operation.catch((error) => new Notice(errorText(error)));
  }

  private async pickBoard(): Promise<void> {
    const choices = (await discoverBoards(this.app)).filter(({ file }) => !this.descriptions.isDraft(file));
    if (!choices.length) {
      new Notice(t("No boards found in this vault."));
      return;
    }
    new BoardPicker(this.app, choices, (file) => this.report(this.openBoard(file))).open();
  }

  private async openRecognized(file: TFile): Promise<void> {
    const format = boardFormat(file.extension);
    if (!format || this.descriptions.isDraft(file) || !identifyBoard(await this.app.vault.read(file), format)) {
      throw new Error(t("The file is not marked as a task board."));
    }
    await this.openBoard(file);
  }

  private async openLink(params: Record<string, string>): Promise<void> {
    if (!params.board || !params.item) throw new Error(t("Incomplete task link."));
    if (params.vault && params.vault !== this.app.vault.getName()) {
      throw new Error(t("Open the \"{0}\" vault to access this item.", params.vault));
    }
    const matches = (await discoverBoards(this.app)).filter(({ id, file }) => id === params.board && !this.descriptions.isDraft(file));
    if (!matches.length) throw new Error(t("Board not found in this vault."));
    if (matches.length > 1) throw new Error(t("Multiple files use the same board ID."));
    await this.openBoard(matches[0].file, params.item);
  }

  private async openBoard(file: TFile, id?: string): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE).find((leaf) =>
      leaf.getViewState().state?.file === file.path,
    );
    const leaf = existing ?? this.app.workspace.getLeaf("tab");
    if (!existing) await leaf.setViewState({ type: VIEW_TYPE, active: true, state: { file: file.path } });
    await this.app.workspace.revealLeaf(leaf);
    if (id && leaf.view instanceof BoardView) {
      await leaf.view.reload();
      leaf.view.openItem(id);
    }
  }
}

class BoardPicker extends SuggestModal<BoardChoice> {
  constructor(app: App, private boards: BoardChoice[], private openFile: (file: TFile) => void) {
    super(app);
    this.containerEl.setAttrs(languageAttributes());
    this.setPlaceholder(t("Search boards by title or path"));
    this.emptyStateText = t("No boards found.");
  }

  getSuggestions(query: string): BoardChoice[] {
    const key = query.toLocaleLowerCase(getLocale()).trim();
    return this.boards.filter(({ title, file }) => `${title ?? ""} ${file.path}`.toLocaleLowerCase(getLocale()).includes(key));
  }

  renderSuggestion({ title, file }: BoardChoice, el: HTMLElement): void {
    el.createDiv({ text: title ?? file.basename });
    el.createDiv({ text: file.path, cls: "suggestion-note" });
  }

  onChooseSuggestion({ file }: BoardChoice): void {
    this.openFile(file);
  }
}

class CreateBoardModal extends BoardModal {
  private created?: TFile;

  constructor(app: App, private openBoard: (file: TFile) => Promise<void>) {
    super(app, t("Create board"));
  }

  onOpen(): void {
    const title = field(this.contentEl, t("Title")).createEl("input", { type: "text" });
    const file = field(this.contentEl, t("Vault path (optional)")).createEl("input", {
      type: "text",
      placeholder: t("Projects/My board"),
    });
    const format = field(this.contentEl, t("Format")).createEl("select");
    format.createEl("option", { value: "md", text: "Markdown (.md)" });
    format.createEl("option", { value: "json", text: "JSON (.json)" });
    this.errors();
    const actions = this.contentEl.createDiv({ cls: "tb-actions" });
    const save = button(actions, t("Create"), () => void this.run(save, async () => {
      if (!this.created) {
        if (!title.value.trim()) throw new Error(t("Enter a board title."));
        const extension = format.value as BoardFormat;
        // eslint-disable-next-line no-control-regex -- Vault paths cannot contain ASCII control characters.
        const invalidPathCharacters = /[<>:"|?*\u0000-\u001f]/;
        const safeTitle = title.value.trim().replace(/[/\\]/g, "-")
          .replace(new RegExp(invalidPathCharacters.source, "g"), "-").replace(/[. ]+$/, "");
        const name = file.value.trim().replace(/\\/g, "/") || safeTitle || t("Board");
        const stem = name.replace(/\.(md|json)$/i, "");
        if (invalidPathCharacters.test(stem) || stem.split("/").some((part) => !part || part === "." || part === "..")) {
          throw new Error(t("Enter a valid path relative to the vault."));
        }
        const path = normalizePath(`${stem}.${extension}`);
        const board = createBoard(title.value.trim());
        this.created = await this.app.vault.create(path, serializeBoard(board, extension));
      }
      await this.openBoard(this.created);
    }), "mod-cta");
    title.focus();
  }
}
