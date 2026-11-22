import { languageAttributes, t } from "./i18n";
import { Component, MarkdownRenderer, Modal, Notice, setIcon, type App } from "obsidian";
import { entries, type Board, type Status } from "./board";
import { errorText } from "./vault";

export function button(parent: HTMLElement, text: string, action: () => void, className?: string, icon?: string): HTMLButtonElement {
  const control = parent.createEl("button", { text, cls: className });
  control.type = "button";
  if (icon) {
    const symbol = control.createSpan({ cls: "tb-button-icon", prepend: true, attr: { "aria-hidden": "true" } });
    setIcon(symbol, icon);
  }
  control.addEventListener("click", action);
  return control;
}

export function field(parent: HTMLElement, name: string): HTMLLabelElement {
  const label = parent.createEl("label", { cls: "tb-field" });
  label.createSpan({ text: name });
  return label;
}

export function statusSelect(parent: HTMLElement, statuses: Status[], current: string, label: string): HTMLSelectElement {
  const select = parent.createEl("select", { attr: { "aria-label": label } });
  for (const status of statuses) select.createEl("option", { value: status.id, text: status.title });
  select.value = current;
  return select;
}

export class BoardModal extends Modal {
  private saving = false;
  private errorEl!: HTMLElement;

  constructor(app: App, title: string) {
    super(app);
    this.setTitle(title);
    this.modalEl.addClass("tb-modal");
    this.modalEl.setAttrs(languageAttributes());
  }

  protected errors(): void {
    this.errorEl = this.contentEl.createDiv({ cls: "tb-error", attr: { role: "alert" } });
  }

  protected async run(control: HTMLButtonElement, action: () => Promise<void>): Promise<void> {
    if (this.saving) return;
    this.saving = true;
    control.disabled = true;
    this.errorEl.setText("");
    try {
      await action();
      this.close();
    } catch (error) {
      this.errorEl.setText(errorText(error));
    } finally {
      this.saving = false;
      control.disabled = false;
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class ConfirmDelete extends BoardModal {
  constructor(app: App, private title: string, private count: number, private links: number, private save: () => Promise<void>) {
    super(app, t("Delete item"));
  }

  onOpen(): void {
    this.contentEl.createEl("p", { text: t("\"{0}\" will be deleted. Items to delete: {1}. Links to remove: {2}.", this.title, this.count, this.links) });
    this.errors();
    const actions = this.contentEl.createDiv({ cls: "tb-actions" });
    button(actions, t("Cancel"), () => this.close());
    const confirm = button(actions, t("Delete"), () => void this.run(confirm, this.save), "mod-warning");
  }
}

export class MarkdownPreview {
  private component?: Component;

  constructor(private app: App, private path: string) {}

  render(markdown: string, container: HTMLElement): void {
    this.clear();
    // A detached node keeps a superseded async render out of the current preview.
    container.empty();
    const body = container.createDiv({ cls: "markdown-rendered", attr: { dir: "auto" } });
    const component = new Component();
    this.component = component;
    component.load();
    component.registerDomEvent(body, "click", (event) => {
      if (event.defaultPrevented || event.button !== 0) return;
      const win = body.ownerDocument.defaultView;
      if (!win || !(event.target instanceof win.Node)) return;
      const target = event.target instanceof win.Element ? event.target : event.target.parentElement;
      const link = target?.closest<HTMLAnchorElement>("a.internal-link");
      const href = link?.getAttribute("data-href") ?? link?.getAttribute("href");
      if (!href) return;
      event.preventDefault();
      void this.app.workspace.openLinkText(href, this.path, event.ctrlKey || event.metaKey);
    });
    void MarkdownRenderer.render(this.app, markdown, body, this.path, component).catch((error) => {
      if (this.component === component) body.setText(errorText(error));
    });
  }

  clear(): void {
    this.component?.unload();
    this.component = undefined;
  }
}

export class StatusModal extends BoardModal {
  private draft: Status[];
  private removed = new Set<string>();
  private replacements = new Map<string, string>();
  private list!: HTMLElement;

  constructor(app: App, private board: Board, private save: (statuses: Status[], replacements: ReadonlyMap<string, string>) => Promise<void>) {
    super(app, t("Board statuses"));
    this.draft = board.statuses.map((status) => ({ ...status }));
  }

  onOpen(): void {
    this.list = this.contentEl.createDiv({ cls: "tb-status-list" });
    this.renderList();
    button(this.contentEl, t("Add status"), () => {
      this.draft.push({ id: crypto.randomUUID(), title: t("New status"), done: false });
      this.renderList();
    });
    this.errors();
    const controls = this.contentEl.createDiv({ cls: "tb-actions" });
    const save = button(controls, t("Save statuses"), () => void this.run(save, async () => {
      await this.save(this.draft.map((status) => ({ ...status, title: status.title.trim() })), this.replacements);
    }), "mod-cta");
  }

  private renderList(): void {
    this.list.empty();
    this.draft.forEach((status, index) => {
      const row = this.list.createDiv({ cls: "tb-status-row" });
      const title = row.createEl("input", { type: "text", value: status.title, attr: { "aria-label": t("Status name") } });
      title.addEventListener("input", () => {
        status.title = title.value;
        for (const option of this.list.querySelectorAll<HTMLOptionElement>("option")) {
          if (option.value === status.id) option.text = status.title;
        }
      });
      const label = row.createEl("label");
      const done = label.createEl("input", { type: "checkbox" });
      done.checked = status.done;
      done.addEventListener("change", () => status.done = done.checked);
      label.appendText(t("Done"));
      this.reorderButton(row, index, -1, "↑", t("Move up"));
      this.reorderButton(row, index, 1, "↓", t("Move down"));
      button(row, t("Remove"), () => {
        this.draft.splice(index, 1);
        if (this.board.statuses.some(({ id }) => id === status.id)) this.removed.add(status.id);
        this.renderList();
      }).disabled = this.draft.length === 1;
    });
    for (const id of this.removed) {
      const removed = this.board.statuses.find((status) => status.id === id);
      const inUse = entries(this.board).some(({ item }) => item.status === id);
      const label = field(this.list, t("Replacement for {0}{1}", removed?.title, inUse ? t(" (in use)") : ""));
      const select = statusSelect(label, this.draft, "", t("Replacement status"));
      select.prepend(select.createEl("option", { text: t("Choose status"), value: "" }));
      select.value = this.replacements.get(id) ?? "";
      select.addEventListener("change", () => this.replacements.set(id, select.value));
    }
  }

  private reorderButton(row: HTMLElement, index: number, offset: number, icon: string, label: string): void {
    const next = index + offset;
    const move = button(row, icon, () => {
      [this.draft[index], this.draft[next]] = [this.draft[next], this.draft[index]];
      this.renderList();
    });
    move.setAttribute("aria-label", label);
    move.disabled = next < 0 || next >= this.draft.length;
  }
}

export async function copyItemLink(app: App, board: Board, id: string, clipboard: Clipboard): Promise<void> {
  const params = new URLSearchParams({ vault: app.vault.getName(), board: board.id, item: id });
  await clipboard.writeText(`obsidian://${manifest.id}?${params.toString().replace(/\+/g, "%20")}`);
  new Notice(t("Link copied."));
}
import manifest from "../manifest.json";
