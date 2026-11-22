import { formatNumber, languageAttributes, t } from "./i18n";
import { ItemView, Notice, TFile, setIcon, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { entries, updateItem, updateStatuses, type Board, type Entry, type Mutation, type TaskItem } from "./board";
import type { DescriptionEditor } from "./description-editor";
import { boardFormat, parseBoard } from "./formats";
import { EditItemModal, ItemModal } from "./item-modal";
import { TABLE_COLUMNS, nextTableSort, readTableSort, tableComparator, type TableSort } from "./table-sort";
import { BoardModal, StatusModal, button, field, statusSelect } from "./ui";
import { changeBoard, errorText, openMarkdownOriginal } from "./vault";

export const VIEW_TYPE = "task-board-view";

interface ColumnDraft {
  boardId: string;
  title: string;
  done: boolean;
  saving?: boolean;
  error?: string;
}

export class BoardView extends ItemView {
  file?: TFile;
  private path = "";
  private board?: Board;
  private problem = "";
  private revision = 0;
  private mode: "table" | "kanban" = "table";
  private sorting?: TableSort;
  private columnDraft?: ColumnDraft;
  private subtasks: "grouped" | "columns" = "grouped";
  private expanded = new Set<string>();
  private byId = new Map<string, Entry>();
  private completed = new Set<string>();
  private drag?: { id: string; board: Board };
  private body!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, private descriptions: DescriptionEditor) {
    super(leaf);
    this.navigation = true;
  }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return this.board?.title ?? this.file?.basename ?? manifest.name; }
  getIcon(): string { return "kanban"; }

  getState(): Record<string, unknown> {
    return { ...super.getState(), file: this.file?.path ?? this.path, mode: this.mode, subtasks: this.subtasks, sorting: this.sorting };
  }

  async setState(state: Record<string, unknown>, result: ViewStateResult): Promise<void> {
    await super.setState(state, result);
    const path = typeof state.file === "string" ? state.file : "";
    if (path !== this.path) {
      result.history = true;
      this.expanded.clear();
      this.columnDraft = undefined;
    }
    this.path = path;
    const file = this.app.vault.getAbstractFileByPath(this.path);
    this.file = file instanceof TFile ? file : undefined;
    this.mode = state.mode === "kanban" ? "kanban" : "table";
    this.sorting = readTableSort(state.sorting);
    this.subtasks = state.subtasks === "columns" ? "columns" : "grouped";
    await this.reload();
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("tb-view");
    this.contentEl.setAttrs(languageAttributes());
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file === this.file) void this.reload();
    }));
    this.registerEvent(this.app.vault.on("create", (file) => {
      if (!this.file && file instanceof TFile && file.path === this.path) {
        this.file = file;
        void this.reload();
      }
    }));
    this.registerEvent(this.app.vault.on("rename", (file) => {
      if (file !== this.file) return;
      this.path = file.path;
      this.app.workspace.requestSaveLayout();
      void this.reload();
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (file !== this.file) return;
      this.file = undefined;
      void this.reload();
    }));
  }

  async onClose(): Promise<void> {
    this.revision++;
  }

  async reload(): Promise<void> {
    const file = this.file;
    const revision = ++this.revision;
    let board: Board | undefined;
    let problem = "";
    try {
      if (!file) throw new Error(t("Board file unavailable."));
      const format = boardFormat(file.extension);
      if (!format) throw new Error(t("The board must be a Markdown or JSON file."));
      board = parseBoard(await this.app.vault.read(file), format).board;
    } catch (error) {
      problem = errorText(error);
    }
    if (revision !== this.revision) return;
    this.board = board;
    this.problem = problem;
    this.render();
  }

  openItem(id: string): void {
    const entry = this.byId.get(id);
    const context = this.itemContext();
    if (!entry || !context) {
      new Notice(this.problem || t("Item unavailable."));
      return;
    }
    new ItemModal(context, entry).open();
  }

  private itemContext() {
    const file = this.file;
    const board = this.board;
    if (!file || !board) return;
    return {
      app: this.app,
      path: file.path,
      board,
      commit: (mutation: Mutation) => this.commit(file, board, mutation),
      editDescription: (item: Entry["item"]) => this.descriptions.open(file, board, item),
      open: (id: string) => this.openItem(id),
      create: (parentId: string) => this.createItem(parentId),
    };
  }

  private createItem(parentId?: string): void {
    const context = this.itemContext();
    if (context) new EditItemModal(context, undefined, parentId).open();
  }

  private async commit(file: TFile, board: Board, mutation: Mutation): Promise<void> {
    await changeBoard(this.app, file, board.id, mutation);
    if (file === this.file) await this.reload();
  }

  private render(): void {
    const board = this.board;
    this.byId = new Map(board && entries(board).map((entry) => [entry.item.id, entry]));
    this.completed = new Set(board?.statuses.filter((status) => status.done).map(({ id }) => id));
    this.contentEl.empty();
    const header = this.contentEl.createDiv({ cls: "tb-header" });
    const summary = header.createDiv({ cls: "tb-board-summary" });
    const heading = summary.createDiv();
    heading.createEl("h1", { text: this.getDisplayText() });
    const actions = summary.createDiv({ cls: "tb-actions" });
    const file = this.file;
    if (file) {
      const label = boardFormat(file.extension) === "md" ? t("Open original Markdown") : t("Open source");
      button(actions, label, () => this.openSource(file), "tb-quiet-button", "file-code");
    }
    if (!file || !board) {
      this.contentEl.createEl("p", { text: this.problem, cls: "tb-error", attr: { role: "alert" } });
      return;
    }
    button(actions, t("New task"), () => this.createItem(), "mod-cta", "plus");
    const active = board.tasks.filter((task) => !task.archived);
    if (active.length) {
      const done = active.filter((task) => this.completed.has(task.status)).length;
      const progress = heading.createDiv({ cls: "tb-board-progress" });
      progress.createSpan({ text: t("Completed tasks: {0}/{1}", done, active.length) });
      this.progress(progress, done, active.length, t("Completed tasks"));
    }
    const toolbar = header.createDiv({ cls: "tb-toolbar" });
    const modes = toolbar.createDiv({ cls: "tb-modes", attr: { role: "group", "aria-label": t("View") } });
    for (const [mode, label, icon] of [["table", t("Table"), "table-2"], ["kanban", t("Kanban"), "kanban"]] as const) {
      const tab = button(modes, label, () => {
        if (this.mode === mode) return;
        this.mode = mode;
        this.app.workspace.requestSaveLayout();
        this.render();
        this.contentEl.querySelector<HTMLElement>(".tb-modes [aria-pressed=true]")?.focus();
      }, undefined, icon);
      tab.setAttribute("aria-pressed", String(mode === this.mode));
    }
    const tools = toolbar.createDiv({ cls: "tb-actions" });
    const columnDraft = this.columnDraft?.boardId === board.id ? this.columnDraft : undefined;
    if (this.mode === "kanban") {
      const select = field(tools, t("Subtasks")).createEl("select");
      select.createEl("option", { value: "grouped", text: t("Grouped in parent cards") });
      select.createEl("option", { value: "columns", text: t("In their own status column") });
      select.value = this.subtasks;
      select.addEventListener("change", () => {
        this.subtasks = select.value === "columns" ? "columns" : "grouped";
        this.app.workspace.requestSaveLayout();
        this.renderBody(board);
      });
      const createColumn = button(tools, t("New column"), () => {
        this.columnDraft = columnDraft ? undefined : { boardId: board.id, title: "", done: false };
        this.render();
        if (this.columnDraft) this.contentEl.querySelector<HTMLInputElement>(".tb-column-form input[type=text]")?.focus();
        else this.contentEl.querySelector<HTMLButtonElement>(".tb-new-column")?.focus();
      }, "tb-new-column", "plus");
      createColumn.setAttribute("aria-expanded", String(Boolean(columnDraft)));
      createColumn.disabled = Boolean(columnDraft?.saving);
    }
    button(tools, t("Status"), () => new StatusModal(this.app, board, (statuses, replacements) =>
      this.commit(file, board, (latest) => updateStatuses(latest, board.statuses, statuses, replacements)),
    ).open(), "tb-quiet-button", "settings-2");
    if (this.mode === "kanban" && columnDraft) this.renderColumnForm(header, file, board, columnDraft);
    this.body = this.contentEl.createDiv({ cls: "tb-body" });
    this.renderBody(board);
  }

  private renderColumnForm(container: HTMLElement, file: TFile, board: Board, draft: ColumnDraft): void {
    const form = container.createEl("form", { cls: "tb-column-form", attr: { "aria-label": t("Create Kanban column") } });
    const name = field(form, t("Column name")).createEl("input", { type: "text", value: draft.title, attr: { required: "" } });
    name.addEventListener("input", () => draft.title = name.value);
    const completion = form.createEl("label", { cls: "tb-column-completion" });
    const done = completion.createEl("input", { type: "checkbox" });
    done.checked = draft.done;
    done.addEventListener("change", () => draft.done = done.checked);
    completion.appendText(t("Marks items as completed"));
    const actions = form.createDiv({ cls: "tb-actions" });
    const cancel = button(actions, t("Cancel"), () => {
      this.columnDraft = undefined;
      this.render();
      this.contentEl.querySelector<HTMLButtonElement>(".tb-new-column")?.focus();
    });
    const submit = actions.createEl("button", { text: t("Create column"), type: "submit", cls: "mod-cta" });
    for (const control of [name, done, cancel, submit]) control.disabled = Boolean(draft.saving);
    const error = form.createDiv({ cls: "tb-error", text: draft.error ?? "", attr: { role: "alert" } });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (draft.saving) return;
      const title = draft.title.trim();
      if (!title) {
        error.setText(t("Enter a column name."));
        name.focus();
        return;
      }
      draft.error = undefined;
      draft.saving = true;
      this.render();
      void this.addColumn(file, board, draft, title);
    });
  }

  private async addColumn(file: TFile, board: Board, draft: ColumnDraft, title: string): Promise<void> {
    const id = crypto.randomUUID();
    try {
      await this.commit(file, board, (latest) => {
        latest.statuses.push({ id, title, done: draft.done });
      });
      if (this.columnDraft !== draft) return;
      this.columnDraft = undefined;
      this.render();
      this.contentEl.querySelector<HTMLButtonElement>(".tb-new-column")?.focus({ preventScroll: true });
      this.body.querySelector(`.tb-column[data-status="${id}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    } catch (error) {
      draft.error = errorText(error);
      draft.saving = false;
      if (this.columnDraft === draft) this.render();
    }
  }

  private renderBody(board: Board): void {
    this.body.empty();
    const active = board.tasks.filter((task) => !task.archived);
    if (!active.length) {
      const empty = this.body.createDiv({ cls: "tb-empty" });
      empty.createEl("p", { text: t("No active tasks.") });
    }
    if (this.mode === "table") this.table(board, active);
    else this.kanban(board);
  }

  private table(board: Board, active: Board["tasks"]): void {
    const viewport = this.body.createDiv({ cls: "tb-table-scroll" });
    const table = viewport.createEl("table", { cls: "tb-table" });
    const header = table.createTHead().insertRow();
    for (const { key, title, sortLabel } of TABLE_COLUMNS) {
      const heading = header.createEl("th", { attr: { scope: "col" } });
      const direction = this.sorting?.column === key ? this.sorting.direction : undefined;
      if (direction) heading.setAttribute("aria-sort", direction);
      const next = nextTableSort(key, this.sorting);
      const sort = button(heading, t(title), () => {
        const scrollLeft = viewport.scrollLeft;
        this.sorting = next;
        this.app.workspace.requestSaveLayout();
        this.renderBody(board);
        const updated = this.body.querySelector<HTMLElement>(`[data-sort-column="${key}"]`);
        if (updated) {
          updated.closest<HTMLElement>(".tb-table-scroll")?.scrollTo({ left: scrollLeft });
          updated.focus({ preventScroll: true });
        }
      }, "tb-sort-button");
      sort.dataset.sortColumn = key;
      sort.title = next
        ? t("Sort by {0} ({1})", t(sortLabel), next.direction === "ascending" ? t("ascending") : t("descending"))
        : t("Restore board order");
      const icon = sort.createSpan({ cls: "tb-sort-icon", attr: { "aria-hidden": "true" } });
      setIcon(icon, direction ? (direction === "ascending" ? "arrow-up" : "arrow-down") : "arrow-up-down");
    }
    const body = table.createTBody();
    const addRow = (entry: Entry) => {
      const { item, task, parent } = entry;
      const row = body.insertRow();
      if (parent) row.addClass("tb-subtask-row");
      const title = row.insertCell();
      if (parent) title.addClass("tb-subtask");
      if (!parent && task.subtasks.length) this.expand(title, item.id, board);
      this.link(title, item.id, undefined, "tb-task-link");
      if (!parent && task.subtasks.length) {
        const summary = title.createDiv({ cls: "tb-subtask-summary tb-detail" });
        this.subtaskProgress(summary, task);
      }
      this.statusControl(row.insertCell(), board, entry);
      this.dependencies(row.insertCell(), entry);
      for (const field of ["branch", "commit"] as const) {
        const cell = row.insertCell();
        if (item.git?.[field]) cell.createEl("code", { text: item.git[field] });
      }
    };
    const compare = this.sorting && tableComparator(this.sorting, board.statuses);
    const order = <T extends TaskItem>(items: T[]): T[] => compare ? [...items].sort(compare) : items;
    for (const task of order(active)) {
      addRow({ item: task, task });
      if (this.expanded.has(task.id)) {
        for (const item of order(task.subtasks)) addRow({ item, task, parent: task });
      }
    }
  }

  private kanban(board: Board): void {
    const lane = this.body.createDiv({ cls: "tb-kanban" });
    const grouped = this.subtasks === "grouped";
    const visible = [...this.byId.values()].filter(({ task, parent }) =>
      !task.archived && (!grouped || !parent),
    );
    for (const status of board.statuses) {
      const column = lane.createEl("section", { cls: "tb-column", attr: { "aria-label": status.title, "data-status": status.id } });
      if (status.done) column.addClass("is-done");
      const cards = visible.filter(({ item }) => item.status === status.id);
      const heading = column.createEl("h2", { text: status.title });
      heading.createSpan({ text: formatNumber(cards.length), cls: "tb-count" });
      column.addEventListener("dragover", (event) => {
        if (this.drag?.board === board) event.preventDefault();
      });
      column.addEventListener("drop", (event) => {
        if (this.drag?.board !== board) return;
        event.preventDefault();
        const entry = this.byId.get(this.drag.id);
        this.drag = undefined;
        if (entry) this.move(board, entry, status.id);
      });
      for (const entry of cards) {
        const card = this.card(column, board, entry);
        if (grouped && entry.task.subtasks.length) {
          const summary = card.createDiv({ cls: "tb-subtask-summary tb-detail" });
          this.expand(summary, entry.item.id, board);
          this.subtaskProgress(summary, entry.task);
          if (this.expanded.has(entry.item.id)) {
            const children = card.createDiv({ cls: "tb-card-children" });
            for (const item of entry.task.subtasks) {
              const child = this.byId.get(item.id);
              if (child) this.card(children, board, child, true);
            }
          }
        }
      }
    }
  }

  private card(container: HTMLElement, board: Board, entry: Entry, nested = false): HTMLElement {
    const { item, parent } = entry;
    const card = container.createEl("article", { cls: nested ? "tb-card tb-card-nested" : "tb-card" });
    const heading = card.createDiv({ cls: "tb-card-title" });
    if (!nested) {
      heading.draggable = true;
      heading.addEventListener("dragstart", (event) => {
        this.drag = { id: item.id, board };
        event.dataTransfer?.setData("application/x-obsidian-task-board-item", item.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      });
      heading.addEventListener("dragend", () => this.drag = undefined);
    }
    this.link(heading, item.id, undefined, "tb-task-link");
    if (parent && !nested) this.link(card, parent.id, t("Parent"));
    this.statusControl(card, board, entry);
    this.dependencies(card, entry);
    return card;
  }

  private expand(container: HTMLElement, id: string, board: Board): void {
    const open = this.expanded.has(id);
    const toggle = button(container, "", () => {
      if (open) this.expanded.delete(id);
      else this.expanded.add(id);
      this.renderBody(board);
      // The rendering replaces the old button.
      this.body.querySelector<HTMLElement>(`[data-expand="${id}"]`)?.focus();
    }, "tb-expand", open ? "chevron-down" : "chevron-right");
    toggle.dataset.expand = id;
    toggle.setAttribute("aria-label", open ? t("Collapse subtasks") : t("Expand subtasks"));
    toggle.setAttribute("aria-expanded", String(open));
  }

  private progress(container: HTMLElement, done: number, total: number, label: string): void {
    const progress = container.createEl("progress", { attr: { "aria-label": label } });
    progress.max = total;
    progress.value = done;
  }

  private subtaskProgress(container: HTMLElement, task: Board["tasks"][number]): void {
    const total = task.subtasks.length;
    const done = task.subtasks.filter((item) => this.completed.has(item.status)).length;
    container.createSpan({ text: t("Subtasks: {0}/{1}", done, total) });
    this.progress(container, done, total, t("Completed subtasks for {0}", task.title));
  }

  private link(container: HTMLElement, id: string, prefix?: string, style = ""): void {
    const entry = this.byId.get(id);
    if (!entry) return;
    const title = prefix ? `${prefix} · ${entry.item.title}` : entry.item.title;
    button(container, title, () => this.openItem(id), `tb-text-button ${style}`.trim());
  }

  private dependencies(container: HTMLElement, { item }: Entry): void {
    if (!item.dependsOn.length) return;
    const group = container.createDiv({ cls: "tb-dependencies" });
    for (const id of item.dependsOn) {
      const target = this.byId.get(id);
      const pending = target && !this.completed.has(target.item.status);
      this.link(group, id, pending ? t("Pending") : undefined, pending ? "tb-pending" : "");
    }
  }

  private statusControl(container: HTMLElement, board: Board, entry: Entry): void {
    const { item } = entry;
    const wrapper = container.createDiv({
      cls: this.completed.has(item.status) ? "tb-status-select is-done" : "tb-status-select",
      attr: { "data-status": item.status },
    });
    const select = statusSelect(wrapper, board.statuses, item.status, t("Status of {0}", item.title));
    select.addEventListener("change", () => {
      const status = select.value;
      select.value = item.status;
      this.move(board, entry, status);
    });
  }

  private move(board: Board, { item }: Entry, status: string): void {
    if (status === item.status || !this.file) return;
    void this.commit(this.file, board, (latest) => {
      updateItem(latest, item.id, item, { ...item, status });
    }).catch((error) => new Notice(errorText(error)));
  }

  private openSource(file: TFile): void {
    if (boardFormat(file.extension) === "md") {
      void openMarkdownOriginal(this.app, file).catch((error) => new Notice(errorText(error)));
      return;
    }
    void this.app.vault.read(file).then((source) => {
      new JsonSourceModal(this, file, source).open();
    }).catch((error) => new Notice(errorText(error)));
  }
}

class JsonSourceModal extends BoardModal {
  constructor(private view: BoardView, private file: TFile, private source: string) {
    super(view.app, file.path);
  }

  onOpen(): void {
    const text = field(this.contentEl, t("JSON source")).createEl("textarea", { cls: "tb-json-source", attr: { rows: "20", spellcheck: "false" } });
    text.value = this.source;
    this.errors();
    const actions = this.contentEl.createDiv({ cls: "tb-actions" });
    button(actions, t("Close"), () => this.close());
    const save = button(actions, t("Save JSON"), () => void this.run(save, async () => {
      parseBoard(text.value, "json");
      await this.app.vault.process(this.file, (current) => {
        if (current !== this.source) throw new Error(t("The file changed. Your edited text is still available."));
        return text.value;
      });
      await this.view.reload();
    }), "mod-cta");
  }
}
import manifest from "../manifest.json";
