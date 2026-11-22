import { t } from "./i18n";
import { Notice, Scope, type App } from "obsidian";
import {
  deleteItem, deletionImpact, requireEntry, updateItem,
  type Board, type Entry, type ItemFields, type Mutation, type TaskItem,
} from "./board";
import { DependencyPicker } from "./dependency-picker";
import { BoardModal, ConfirmDelete, MarkdownPreview, button, copyItemLink, field, statusSelect } from "./ui";
import { errorText } from "./vault";

interface ItemContext {
  app: App;
  path: string;
  board: Board;
  commit: (mutation: Mutation) => Promise<void>;
  editDescription: (item: TaskItem) => Promise<void>;
  open: (id: string) => void;
  create: (parentId: string) => void;
}

export class ItemModal extends BoardModal {
  private preview: MarkdownPreview;

  constructor(private context: ItemContext, private entry: Entry) {
    super(context.app, entry.item.title);
    this.modalEl.addClass("tb-item-modal");
    this.preview = new MarkdownPreview(context.app, context.path);
  }

  onOpen(): void {
    const { board } = this.context;
    const { item, task, parent } = this.entry;
    const header = this.contentEl.createDiv({ cls: "tb-item-header" });
    const meta = header.createDiv({ cls: "tb-detail" });
    if (parent) button(meta, t("Back to parent task"), () => this.openItem(parent.id), undefined, "arrow-left");
    const status = board.statuses.find(({ id }) => id === item.status);
    meta.createSpan({
      text: status?.title,
      cls: status?.done ? "tb-pill is-done" : "tb-pill",
      attr: { "data-status": item.status },
    });
    if (task.archived) meta.createSpan({ text: t("Archived"), cls: "tb-pill tb-pill-muted" });
    const actions = header.createDiv({ cls: "tb-actions" });
    button(actions, t("Open description"), () => {
      this.close();
      void this.context.editDescription(item).catch((error) => new Notice(errorText(error)));
    }, "mod-cta", "file-pen-line");
    button(actions, t("Edit details"), () => {
      this.close();
      new EditItemModal(this.context, this.entry).open();
    }, undefined, "settings-2");

    const layout = this.contentEl.createDiv({ cls: "tb-item-layout" });
    const description = layout.createEl("section", { cls: "tb-item-description" });
    description.createEl("h3", { text: t("Description") });
    if (item.description) this.preview.render(item.description, description.createDiv({ cls: "tb-description" }));
    else description.createEl("p", { text: t("No description."), cls: "tb-muted" });
    const sidebar = layout.createEl("aside", { cls: "tb-item-sidebar" });
    if (item.dependsOn.length) {
      const section = sidebar.createEl("section");
      section.createEl("h3", { text: t("Dependencies") });
      for (const id of item.dependsOn) {
        const { item: target } = requireEntry(board, id);
        const done = board.statuses.some((status) => status.id === target.status && status.done);
        this.link(section.createDiv(), target, done ? t("Completed") : t("Pending"));
      }
    }
    if (!parent) {
      const section = sidebar.createEl("section");
      section.createEl("h3", { text: t("Subtasks") });
      for (const child of task.subtasks) this.link(section.createDiv(), child);
      button(section, t("Add subtask"), () => {
        this.close();
        this.context.create(task.id);
      }, "tb-sidebar-action", "plus");
    } else {
      const section = sidebar.createEl("section");
      section.createEl("h3", { text: t("Parent task") });
      this.link(section, parent);
    }
    if (item.git?.branch || item.git?.commit) {
      const section = sidebar.createEl("section");
      section.createEl("h3", { text: "Git" });
      const values = section.createEl("dl", { cls: "tb-item-git" });
      for (const [label, value] of [[t("Branch"), item.git.branch], [t("Commit"), item.git.commit]]) {
        if (!value) continue;
        values.createEl("dt", { text: label });
        values.createEl("dd").createEl("code", { text: value });
      }
    }
    this.errors();
    const footer = this.contentEl.createDiv({ cls: "tb-actions tb-item-footer" });
    button(footer, t("Copy link"), () => {
      const clipboard = this.contentEl.ownerDocument.defaultView!.navigator.clipboard;
      void copyItemLink(this.app, board, item.id, clipboard).catch((error) => new Notice(errorText(error)));
    }, undefined, "link");
    if (!parent) {
      const archive = button(footer, task.archived ? t("Unarchive") : t("Archive"), () => void this.run(archive, async () => {
        await this.context.commit((latest) => {
          const current = requireEntry(latest, task.id);
          if (current.parent) throw new Error(t("This item is now a subtask."));
          current.task.archived = !task.archived;
        });
      }), undefined, task.archived ? "archive-restore" : "archive");
    } else if (task.archived) {
      button(footer, t("Open parent task to unarchive"), () => this.openItem(task.id));
    }
    button(footer, t("Delete"), () => {
      const impact = deletionImpact(board, item.id);
      new ConfirmDelete(this.app, item.title, impact.removed.length, impact.links.length, async () => {
        await this.context.commit((latest) => deleteItem(latest, item.id, impact));
        this.close();
      }).open();
    }, "tb-danger", "trash-2");
  }

  onClose(): void {
    this.preview.clear();
    super.onClose();
  }

  private link(container: HTMLElement, item: TaskItem, prefix?: string): void {
    button(container, prefix ? `${prefix} · ${item.title}` : item.title, () => this.openItem(item.id), "tb-text-button");
  }

  private openItem(id: string): void {
    this.close();
    this.context.open(id);
  }
}

export class EditItemModal extends BoardModal {
  private dependencies?: DependencyPicker;

  constructor(private context: ItemContext, private entry?: Entry, private parentId?: string) {
    super(context.app, entry ? t("Edit details") : parentId ? t("New subtask") : t("New task"));
    this.modalEl.addClass("tb-edit-modal");
    this.scope = new Scope(this.scope);
    this.scope.register([], "Escape", () => {
      if (!this.dependencies?.closeIfOpen()) this.close();
      return false;
    });
  }

  onOpen(): void {
    const { board } = this.context;
    const base = this.entry?.item;
    const parentId = this.entry?.parent?.id ?? this.parentId;
    const summary = this.contentEl.createDiv({ cls: "tb-edit-summary" });
    const title = field(summary, t("Title")).createEl("input", { type: "text", value: base?.title ?? "" });
    const status = statusSelect(field(summary, t("Status")), board.statuses, base?.status ?? board.statuses[0].id, t("Status"));
    const git = this.contentEl.createDiv({ cls: "tb-git-fields" });
    const branch = field(git, t("Branch")).createEl("input", { type: "text", value: base?.git?.branch ?? "" });
    const commit = field(git, t("Commit")).createEl("input", { type: "text", value: base?.git?.commit ?? "" });
    const dependencies = new DependencyPicker(this.contentEl, board, base?.dependsOn ?? [], base?.id, parentId);
    this.dependencies = dependencies;

    this.errors();
    const actions = this.contentEl.createDiv({ cls: "tb-actions" });
    button(actions, t("Cancel"), () => this.close());
    const submit = async (openDescription: boolean) => {
      const edited: ItemFields = {
        title: title.value === base?.title ? base.title : title.value.trim(),
        description: base?.description ?? "",
        status: status.value,
        dependsOn: dependencies.value,
        git: {
          branch: branch.value === base?.git?.branch ? base.git.branch : branch.value.trim() || undefined,
          commit: commit.value === base?.git?.commit ? base.git.commit : commit.value.trim() || undefined,
        },
      };
      if (!edited.title) throw new Error(t("Enter a title."));
      const id = base?.id ?? crypto.randomUUID();
      const item = { ...edited, id };
      if (!item.git?.branch && !item.git?.commit) delete item.git;
      else item.git = Object.fromEntries(Object.entries(item.git).filter(([, value]) => value !== undefined));
      await this.context.commit((latest) => {
        if (base) {
          updateItem(latest, id, base, edited);
        } else {
          if (!parentId) latest.tasks.push({ ...item, subtasks: [] });
          else {
            const parent = requireEntry(latest, parentId);
            if (parent.parent) throw new Error(t("The parent task is now a subtask."));
            parent.task.subtasks.push(item);
          }
        }
      });
      if (openDescription) {
        this.close();
        await this.context.editDescription(item).catch((error) => new Notice(errorText(error)));
      }
    };
    const save = button(actions, base ? t("Save") : t("Create"), () => void this.run(save, () => submit(false)), base ? "mod-cta" : undefined);
    if (!base) {
      const createAndEdit = button(actions, t("Create and edit description"), () => void this.run(createAndEdit, () => submit(true)), "mod-cta", "file-pen-line");
    }
    title.focus();
  }

  onClose(): void {
    this.dependencies = undefined;
    super.onClose();
  }
}
