import { languageAttributes, t } from "./i18n";
import { MarkdownView, Notice, TFile, normalizePath, type Menu, type Plugin, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { requireEntry, updateItem, type Board, type TaskItem } from "./board";
import { boardFormat, identifyBoard, parseBoard } from "./formats";
import { changeBoard, discoverBoards, errorText, normalizeMarkdown } from "./vault";

export const DESCRIPTION_VIEW = "task-board-description";

interface Target {
  boardId: string;
  boardPath: string;
  itemId: string;
}

interface Recovery extends Target {
  base: string;
  text: string;
}

interface LegacyDraft extends Target {
  base: string;
  path: string;
}

interface Session extends Recovery {
  file: TFile;
  title: string;
  saving?: Promise<void>;
}

function hasFields(value: unknown, fields: string[]): boolean {
  return !!value && typeof value === "object" &&
    fields.every((field) => typeof (value as Record<string, unknown>)[field] === "string");
}

function isTarget(value: unknown): value is Target {
  return hasFields(value, ["boardId", "boardPath", "itemId"]);
}

function key(target: Target): string {
  return `${target.boardId}/${target.itemId}`;
}

function unchanged(a: string, b: string): boolean {
  return normalizeMarkdown(a) === normalizeMarkdown(b);
}

export class DescriptionEditor {
  private recoveries = new Map<string, Recovery>();
  private legacy: LegacyDraft[] = [];
  private openings = new Map<string, Promise<void>>();
  private virtualText = new Map<string, () => string>();
  private writes = Promise.resolve();
  private ready: Promise<void>;

  constructor(private plugin: Plugin) {
    this.ready = this.load();
  }

  private get app() { return this.plugin.app; }

  initialize(): Promise<void> {
    const workspace = this.app.workspace;
    const adapter = this.app.vault.adapter;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Restore the exact method and invoke it with its original receiver.
    const originalRead = adapter.read;
    const buffers = this.virtualText;
    // Native listeners such as word count also read the editor's file context.
    function read(this: typeof adapter, path: string): Promise<string> {
      const buffer = buffers.get(path);
      return buffer ? Promise.resolve(buffer()) : originalRead.call(this, path);
    }
    adapter.read = read;
    this.plugin.register(() => {
      buffers.clear();
      if (adapter.read === read) adapter.read = originalRead;
    });
    this.plugin.registerEvent(workspace.on("quit", (tasks) => tasks.add(() => this.flush())));
    this.plugin.register(() => void this.flush());
    workspace.onLayoutReady(() => {
      void this.ready.then(() => this.migrate()).catch((error) => new Notice(errorText(error)));
    });
    return this.ready;
  }

  open(boardFile: TFile, board: Board, item: TaskItem): Promise<void> {
    const target = { boardId: board.id, boardPath: boardFile.path, itemId: item.id };
    const id = key(target);
    const pending = this.openings.get(id);
    if (pending) return pending;
    const opening = this.openTarget(target).finally(() => this.openings.delete(id));
    this.openings.set(id, opening);
    return opening;
  }

  isDraft(file: TFile): boolean {
    return this.legacy.some((draft) => draft.path === file.path);
  }

  registerBuffer(path: string, text: () => string): () => void {
    this.virtualText.set(path, text);
    return () => this.virtualText.delete(path);
  }

  async start(target: Target): Promise<Session> {
    await this.ready;
    const file = await this.findBoard(target);
    const format = boardFormat(file.extension);
    if (!format) throw new Error(t("The board format changed."));
    const { board } = parseBoard(await this.app.vault.read(file), format);
    const { item } = requireEntry(board, target.itemId);
    const recovery = this.recoveries.get(key(target));
    return {
      ...target, file, boardPath: file.path, title: item.title,
      base: recovery?.base ?? item.description,
      text: recovery?.text ?? item.description,
    };
  }

  save(session: Session, text: string): Promise<void> {
    session.text = text;
    if (session.saving) return session.saving;
    const saving = this.write(session).finally(() => { session.saving = undefined; });
    session.saving = saving;
    return saving;
  }

  private async write(session: Session): Promise<void> {
    const id = key(session);
    while (!unchanged(session.base, session.text)) {
      const text = session.text;
      const { boardId, itemId, base } = session;
      this.recoveries.set(id, { boardId, itemId, boardPath: session.file.path, base, text });
      await this.persist();
      try {
        await changeBoard(this.app, session.file, boardId, (board) => {
          const { item } = requireEntry(board, itemId);
          // CodeMirror normalizes line endings when opening a document.
          const baseline = unchanged(item.description, base) ? item.description : base;
          const edited = unchanged(item.description, text) ? item.description : text;
          updateItem(board, itemId, { ...item, description: baseline }, { ...item, description: edited });
        });
      } catch (error) {
        if (session.text !== text) {
          this.recoveries.set(id, { boardId, itemId, boardPath: session.file.path, base, text: session.text });
          await this.persist();
        }
        throw error;
      }
      session.base = text;
      session.boardPath = session.file.path;
    }
    if (this.recoveries.delete(id)) await this.persist();
    // An editor can receive new input while the recovery cleanup is being written.
    if (!unchanged(session.base, session.text)) await this.write(session);
  }

  private async load(): Promise<void> {
    const data: unknown = await this.plugin.loadData();
    if (!data || typeof data !== "object") return;
    if ("descriptionRecovery" in data && Array.isArray(data.descriptionRecovery)) {
      for (const value of data.descriptionRecovery) {
        if (isTarget(value) && hasFields(value, ["base", "text"])) this.recoveries.set(key(value), value as Recovery);
      }
    }
    if ("descriptionDrafts" in data && Array.isArray(data.descriptionDrafts)) {
      this.legacy = data.descriptionDrafts.filter((value): value is LegacyDraft =>
        isTarget(value) && hasFields(value, ["base", "path"]),
      );
    }
  }

  private async migrate(): Promise<void> {
    for (const draft of [...this.legacy]) {
      await this.discardDuplicateDraft(draft);
      this.legacy = this.legacy.filter((record) => record !== draft);
      await this.persist();
    }
  }

  private async discardDuplicateDraft(draft: LegacyDraft): Promise<void> {
    // Legacy records only track a path and the starting text. A changed file could be a reused path.
    const { vault, workspace, fileManager } = this.app;
    const file = vault.getFileByPath(draft.path);
    const boardFile = vault.getFileByPath(draft.boardPath);
    if (!file || !boardFile || file === boardFile || file.extension !== "md" || file.parent !== boardFile.parent ||
      !draft.base.trim() || !/^(Descrição — |Rascunho Task Board - )/.test(file.basename)) return;

    const format = boardFormat(boardFile.extension);
    if (!format) return;
    const { ctime, mtime, size } = file.stat;
    try {
      const { board } = parseBoard(await vault.read(boardFile), format);
      if (board.id !== draft.boardId) return;
      const { item } = requireEntry(board, draft.itemId);
      if (!unchanged(item.description, draft.base)) return;
      const { title } = item;
      if (file.basename !== `Descrição — ${title}` && file.basename !== `Rascunho Task Board - ${title}`) return;
      if (!unchanged(await vault.read(file), draft.base)) {
        new Notice(t("Two versions of this description exist. The previous draft was kept for recovery."));
        return;
      }
    } catch {
      // Keep the note if its board, task, or contents can no longer be verified.
      return;
    }
    if (vault.getFileByPath(draft.path) !== file || vault.getFileByPath(draft.boardPath) !== boardFile ||
      file.stat.ctime !== ctime || file.stat.mtime !== mtime || file.stat.size !== size ||
      workspace.getLeavesOfType("markdown").some(({ view }) => view instanceof MarkdownView && view.file === file)) return;
    await fileManager.trashFile(file);
  }

  private async openTarget(target: Target): Promise<void> {
    const workspace = this.app.workspace;
    const existing = workspace.getLeavesOfType(DESCRIPTION_VIEW).find((leaf) => {
      const state = leaf.getViewState().state;
      return isTarget(state) && key(state) === key(target);
    });
    if (existing) {
      await workspace.revealLeaf(existing);
      workspace.setActiveLeaf(existing, { focus: true });
    } else {
      const leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: DESCRIPTION_VIEW, active: true, state: { ...target, mode: "source" } });
      await workspace.revealLeaf(leaf);
    }
  }

  private async findBoard(target: Target): Promise<TFile> {
    const original = this.app.vault.getAbstractFileByPath(target.boardPath);
    if (original instanceof TFile) {
      const format = boardFormat(original.extension);
      if (format && identifyBoard(await this.app.vault.read(original), format)?.id === target.boardId) return original;
    }
    const matches = (await discoverBoards(this.app)).filter(({ id, file }) => id === target.boardId && !this.isDraft(file));
    if (matches.length !== 1) throw new Error(t("Could not find the board for this description."));
    return matches[0].file;
  }

  private persist(): Promise<void> {
    const write = this.writes.catch(() => {}).then(() => this.plugin.saveData({
      descriptionRecovery: [...this.recoveries.values()],
      descriptionDrafts: this.legacy,
    }));
    this.writes = write;
    return write;
  }

  private async flush(): Promise<void> {
    const views = this.app.workspace.getLeavesOfType(DESCRIPTION_VIEW).map(({ view }) => view);
    await Promise.all(views.filter((view): view is DescriptionView => view instanceof DescriptionView).map((view) => view.save()));
  }
}

export class DescriptionView extends MarkdownView {
  private session?: Session;
  private status?: HTMLElement;
  private loading = false;
  private removeBuffer?: () => void;

  constructor(leaf: WorkspaceLeaf, private descriptions: DescriptionEditor) {
    super(leaf);
    this.allowNoFile = true;
    this.containerEl.addClass("tb-description-editor");
    this.contentEl.addClass("tb-native-description");
  }

  override getViewType(): string { return DESCRIPTION_VIEW; }
  override getDisplayText(): string { return this.session ? t("Description — {0}", this.session.title) : t("Description"); }
  override canAcceptExtension(): boolean { return false; }

  override getState(): Record<string, unknown> {
    const { file: _virtualFile, ...native } = super.getState();
    const session = this.session;
    if (!session) return native;
    return { ...native, boardId: session.boardId, boardPath: session.file.path, itemId: session.itemId };
  }

  override async setState(state: Record<string, unknown>, result: ViewStateResult): Promise<void> {
    const { file: _file, ...native } = state;
    if (isTarget(state) && (!this.session || key(this.session) !== key(state))) {
      await this.save();
      this.loading = true;
      try {
        const session = await this.descriptions.start(state);
        this.session = session;
        this.removeBuffer?.();
        this.file = this.virtualFile(session);
        this.data = session.text;
        this.removeBuffer = this.descriptions.registerBuffer(this.file.path, () => this.data);
        await super.setState(native, result);
        this.setViewData(session.text, true);
        this.containerEl.querySelector(".view-header-title")?.setText(this.getDisplayText());
        this.addStatus();
        result.history = true;
        this.app.workspace.requestSaveLayout();
      } finally {
        this.loading = false;
      }
      if (!unchanged(this.session.base, this.session.text)) this.requestSave();
      return;
    }
    await super.setState(native, result);
  }

  override async onOpen(): Promise<void> {
    await super.onOpen();
    this.containerEl.querySelector(".view-header-title")?.setAttribute("contenteditable", "false");
  }

  override async onClose(): Promise<void> {
    try {
      await this.save();
      await super.onClose();
    } finally {
      this.removeBuffer?.();
      this.session = undefined;
    }
  }

  override async save(): Promise<void> {
    if (!this.session || this.loading) return;
    const data = this.getViewData();
    this.data = data;
    if (unchanged(data, this.session.base) && !this.session.saving && !this.status?.hasClass("tb-error")) return;
    this.status?.removeClass("tb-error");
    this.status?.setText(t("Saving…"));
    try {
      await this.descriptions.save(this.session, data);
      this.status?.setText(t("Saved to board"));
    } catch (error) {
      this.status?.addClass("tb-error");
      this.status?.setText(errorText(error));
    }
  }

  async onSwitchView(event: MouseEvent): Promise<void> {
    event.preventDefault();
    await this.toggleMode();
  }

  override onPaneMenu(menu: Menu): void {
    const reading = this.getMode() === "preview";
    menu.addItem((item) => item.setTitle(reading ? t("Edit description") : t("Reading view"))
      .setIcon(reading ? "file-pen-line" : "book-open").onClick(() => this.toggleMode()));
    if (!reading) {
      const state = this.getState();
      menu.addItem((item) => item.setTitle(state.source ? t("Live Preview") : t("Source mode"))
        .setIcon("code-2").onClick(() => this.leaf.setViewState({
          type: DESCRIPTION_VIEW, state: { ...state, source: !state.source },
        })));
    }
  }

  private toggleMode(): Promise<void> {
    const mode = this.getMode() === "preview" ? "source" : "preview";
    return this.leaf.setViewState({ type: DESCRIPTION_VIEW, active: true, state: { ...this.getState(), mode } }, { focus: true });
  }

  private addStatus(): void {
    this.status?.remove();
    this.status = this.contentEl.createDiv({ cls: "tb-description-status", attr: { role: "status", ...languageAttributes() }, prepend: true });
    const session = this.session;
    this.status.setText(session && !unchanged(session.base, session.text) ? t("Pending changes") : t("Saved to board"));
  }

  private virtualFile(session: Session): TFile {
    const parent = session.file.parent;
    const name = `.task-board-${crypto.randomUUID()}.md`;
    // The native editor uses a file context to resolve relative links. Saving goes through the board.
    const file: unknown = Object.create(TFile.prototype);
    if (!(file instanceof TFile)) throw new TypeError("Could not create a Markdown file context.");
    return Object.assign(file, {
      vault: this.app.vault, parent, path: normalizePath(`${parent?.path ?? ""}/${name}`),
      name, basename: session.title, extension: "md", stat: session.file.stat,
    });
  }
}
