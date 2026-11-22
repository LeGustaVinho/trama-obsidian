import { getLocale, t } from "./i18n";
import { setIcon } from "obsidian";
import { dependencyCandidates, entries, type Board } from "./board";
import { button } from "./ui";

interface Choice {
  id: string;
  title: string;
  parentId?: string;
  status: string;
  archived: boolean;
  unavailable?: string;
  searchText: string;
  children: Choice[];
}

interface TreeRow {
  node: HTMLElement;
  line: HTMLElement;
  choice: Choice;
  selectable: boolean;
  expanded?: boolean;
  firstChild?: string;
}

function searchKey(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase(getLocale());
}

export class DependencyPicker {
  private roots: Choice[] = [];
  private byId: ReadonlyMap<string, Choice>;
  private selected: Set<string>;
  private expanded = new Set<string>();
  private collapsedMatches = new Set<string>();
  private trigger: HTMLButtonElement;
  private triggerLabel: HTMLElement;
  private panel: HTMLElement;
  private search: HTMLInputElement;
  private selectedOnly: HTMLInputElement;
  private tree: HTMLElement;
  private chips: HTMLElement;
  private count: HTMLElement;
  private empty: HTMLElement;
  private active?: string;
  private rows = new Map<string, TreeRow>();
  private prefix = `tb-dependency-${crypto.randomUUID()}`;

  constructor(
    container: HTMLElement,
    board: Board,
    private initial: readonly string[],
    itemId?: string,
    parentId?: string,
  ) {
    const candidates = new Map(dependencyCandidates(board, itemId, parentId).map(({ item, wouldCycle }) => [item.id, wouldCycle]));
    const statuses = new Map(board.statuses.map((status) => [status.id, status.title]));
    const collator = new Intl.Collator(getLocale(), { numeric: true, sensitivity: "base" });
    const choices = entries(board).map(({ item, parent, task }): Choice => {
      const status = statuses.get(item.status) ?? "";
      const archived = Boolean(task.archived);
      const unavailable = item.id === itemId ? t("Current item")
        : !candidates.has(item.id) ? t("Only sibling subtasks are allowed")
        : candidates.get(item.id) ? t("Would create a cycle") : undefined;
      return {
        id: item.id, title: item.title, parentId: parent?.id, status, archived, unavailable, children: [],
        searchText: searchKey([item.title, parent?.title, status, archived ? "arquivada" : ""].join(" ")),
      };
    }).sort((a, b) => Number(a.archived) - Number(b.archived) || collator.compare(a.title, b.title));
    this.byId = new Map(choices.map((choice) => [choice.id, choice]));
    for (const choice of choices) {
      const parent = choice.parentId && this.byId.get(choice.parentId);
      if (parent) parent.children.push(choice);
      else this.roots.push(choice);
    }
    this.selected = new Set(initial);
    if (parentId) this.expanded.add(parentId);

    const section = container.createEl("fieldset", { cls: "tb-dependency-picker" });
    section.createEl("legend", { text: t("Dependencies") });
    this.trigger = button(section, "", () => this.setOpen(this.panel.hidden), "tb-dependency-trigger");
    this.trigger.setAttribute("aria-expanded", "false");
    this.trigger.setAttribute("aria-controls", `${this.prefix}-panel`);
    this.triggerLabel = this.trigger.createSpan();
    setIcon(this.trigger.createSpan({ cls: "tb-dependency-trigger-icon", attr: { "aria-hidden": "true" } }), "chevron-down");
    this.chips = section.createDiv({ cls: "tb-dependency-chips", attr: { role: "group", "aria-label": t("Selected dependencies") } });

    this.panel = section.createDiv({ cls: "tb-dependency-panel", attr: { id: `${this.prefix}-panel` } });
    this.panel.hidden = true;
    const toolbar = this.panel.createDiv({ cls: "tb-dependency-toolbar" });
    const searchBox = toolbar.createEl("label", { cls: "tb-dependency-search" });
    setIcon(searchBox.createSpan({ attr: { "aria-hidden": "true" } }), "search");
    this.search = searchBox.createEl("input", {
      type: "search", placeholder: t("Search by title, parent task, or status"),
      attr: { "aria-label": t("Search dependencies"), "aria-controls": `${this.prefix}-tree` },
    });
    const filter = toolbar.createEl("label", { cls: "tb-dependency-filter" });
    this.selectedOnly = filter.createEl("input", { type: "checkbox" });
    filter.appendText(t("Selected only"));
    this.selectedOnly.setAttribute("aria-controls", `${this.prefix}-tree`);
    this.count = this.panel.createDiv({ cls: "tb-dependency-count", attr: { role: "status" } });
    this.tree = this.panel.createDiv({
      cls: "tb-dependency-results",
      attr: { id: `${this.prefix}-tree`, role: "tree", "aria-multiselectable": "true", "aria-label": t("Dependency tree") },
    });
    this.empty = this.panel.createDiv({ cls: "tb-dependency-empty" });
    const footer = this.panel.createDiv({ cls: "tb-dependency-footer" });
    button(footer, t("Done selecting"), () => this.setOpen(false));

    this.search.addEventListener("input", () => this.filterChanged());
    this.selectedOnly.addEventListener("change", () => this.filterChanged());
    this.trigger.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" && this.panel.hidden) {
        event.preventDefault();
        this.setOpen(true);
      }
    });
    section.addEventListener("focusout", (event) => {
      const win = section.ownerDocument.defaultView;
      const next = event.relatedTarget as Node | null;
      if (!this.panel.hidden && win && next?.instanceOf?.(win.Node) && !section.contains(next)) {
        this.setOpen(false, false);
      }
    });
    this.search.addEventListener("keydown", (event) => {
      if (!["ArrowDown", "ArrowUp", "Enter"].includes(event.key) || !this.rows.size) return;
      event.preventDefault();
      this.tree.focus();
      const ids = [...this.rows.keys()];
      this.focusRow(event.key === "ArrowUp" ? ids.at(-1) : ids[0]);
    });
    this.tree.addEventListener("focus", () => {
      const ids = [...this.rows.keys()];
      this.focusRow(this.active ?? ids.find((id) => this.selected.has(id)) ?? ids[0]);
    });
    this.tree.addEventListener("keydown", (event) => this.navigate(event));
    this.renderSelection();
  }

  get value(): string[] {
    const additions = new Set(this.selected);
    return [...this.initial.filter((id) => additions.delete(id)), ...additions];
  }

  closeIfOpen(): boolean {
    if (this.panel.hidden) return false;
    this.setOpen(false);
    return true;
  }

  private setOpen(open: boolean, focus = true): void {
    this.panel.hidden = !open;
    this.trigger.setAttribute("aria-expanded", String(open));
    if (open) {
      this.search.value = "";
      this.selectedOnly.checked = false;
      this.filterChanged();
      this.search.focus();
    } else if (focus) {
      this.trigger.focus();
    }
  }

  private get filtering(): boolean {
    return this.selectedOnly.checked || this.search.value.trim().length > 0;
  }

  private filterChanged(): void {
    this.active = undefined;
    this.collapsedMatches.clear();
    this.tree.scrollTop = 0;
    this.renderTree();
  }

  private renderTree(): void {
    const words = searchKey(this.search.value).trim().split(/\s+/).filter(Boolean);
    const matches = (choice: Choice) => (!this.selectedOnly.checked || this.selected.has(choice.id)) &&
      words.every((word) => choice.searchText.includes(word));
    const scrollTop = this.tree.scrollTop;
    const focused = this.tree === this.tree.ownerDocument.activeElement;
    this.tree.empty();
    this.rows.clear();
    let count = 0;
    for (const root of this.roots) {
      const children = root.children.filter(matches);
      const rootMatches = matches(root);
      if (!rootMatches && !children.length) continue;
      count += Number(rootMatches) + children.length;
      this.renderNode(this.tree, root, children);
    }
    this.count.setText(t("Results: {0}", count));
    this.tree.hidden = count === 0;
    this.tree.tabIndex = this.rows.size ? 0 : -1;
    this.empty.hidden = count > 0;
    if (!count) this.empty.setText(this.selectedOnly.checked && !this.selected.size
      ? t("No dependencies selected.")
      : this.roots.length ? t("No dependencies match the search.") : t("This board has no tasks."));
    this.tree.scrollTop = scrollTop;
    const fallback = focused ? this.rows.keys().next().value : undefined;
    this.focusRow(this.active && this.rows.has(this.active) ? this.active : fallback, false);
    if (!count && focused) this.search.focus();
  }

  private renderSelection(): void {
    const count = this.selected.size;
    const label = !count ? t("Select dependencies") : t("Dependencies selected: {0}", count);
    this.triggerLabel.setText(label);
    this.trigger.setAttribute("aria-label", count ? t("Select dependencies, {0}", label) : label);
    this.chips.empty();
    this.chips.hidden = count === 0;
    for (const id of this.value) {
      const choice = this.byId.get(id);
      const parent = choice?.parentId ? this.byId.get(choice.parentId) : undefined;
      const title = parent ? `${choice?.title} · ${parent.title}` : choice?.title ?? id;
      const chip = button(this.chips, title, () => {
        const index = [...this.chips.querySelectorAll("button")].indexOf(chip);
        this.toggle(id);
        const next = this.chips.querySelectorAll("button");
        (next[Math.min(index, next.length - 1)] ?? (this.panel.hidden ? this.trigger : this.search)).focus();
      }, "tb-dependency-chip", "x");
      chip.setAttribute("aria-label", t("Remove {0}", title));
      chip.title = t("Remove {0}", title);
    }
  }

  private renderNode(group: HTMLElement, choice: Choice, children: Choice[] = []): void {
    const id = `${this.prefix}-${choice.id}`;
    const selected = this.selected.has(choice.id);
    const blocked = !!choice.unavailable && !selected;
    const selectable = !blocked && (!this.selectedOnly.checked || selected);
    const node = group.createDiv({ attr: { id, role: "treeitem", "aria-labelledby": `${id}-label`, "aria-describedby": `${id}-info` } });
    if (selectable) node.setAttribute("aria-selected", String(selected));
    else if (blocked && !children.length) node.setAttribute("aria-disabled", "true");
    const line = node.createDiv({ cls: "tb-dependency-option" });
    if (!selectable) line.dataset.unavailable = "true";
    if (selected) line.addClass("is-selected");

    const caret = line.createSpan({ cls: "tb-dependency-caret", attr: { "aria-hidden": "true" } });
    const expanded = children.length
      ? (this.filtering ? !this.collapsedMatches.has(choice.id) : this.expanded.has(choice.id))
      : undefined;
    if (expanded !== undefined) {
      node.setAttribute("aria-expanded", String(expanded));
      setIcon(caret, expanded ? "chevron-down" : "chevron-right");
      caret.addEventListener("click", (event) => {
        event.stopPropagation();
        this.setBranch(choice.id, !expanded);
      });
    }
    line.createSpan({ cls: "tb-dependency-check", attr: { "aria-hidden": "true" } });
    line.createDiv({ text: choice.title, cls: "tb-dependency-label", attr: { id: `${id}-label` } });
    const tags = line.createDiv({ cls: "tb-dependency-tags", attr: { id: `${id}-info` } });
    if (blocked) tags.createSpan({ text: choice.unavailable, cls: "tb-dependency-cycle" });
    if (choice.archived) tags.createSpan({ text: t("Archived") });
    if (choice.status) tags.createSpan({ text: choice.status });
    this.rows.set(choice.id, { node, line, choice, selectable, expanded, firstChild: children[0]?.id });
    line.addEventListener("click", () => {
      this.focusRow(choice.id, false);
      if (selectable) this.toggle(choice.id);
      else if (expanded !== undefined) this.setBranch(choice.id, !expanded);
    });
    if (expanded) {
      const branch = node.createDiv({ cls: "tb-dependency-branch", attr: { role: "group" } });
      for (const child of children) this.renderNode(branch, child);
    }
  }

  private setBranch(id: string, open: boolean): void {
    if (this.filtering) {
      if (open) this.collapsedMatches.delete(id);
      else this.collapsedMatches.add(id);
    } else if (open) {
      this.expanded.add(id);
    } else {
      this.expanded.delete(id);
    }
    this.active = id;
    this.renderTree();
    if (open && this.tree === this.tree.ownerDocument.activeElement) this.focusRow(id);
  }

  private toggle(id: string): void {
    if (!this.selected.delete(id)) this.selected.add(id);
    this.renderSelection();
    if (!this.panel.hidden) this.renderTree();
  }

  private navigate(event: KeyboardEvent): void {
    const ids = [...this.rows.keys()];
    if (!ids.length) return;
    const index = Math.max(0, ids.indexOf(this.active ?? ""));
    const id = ids[index];
    const row = this.rows.get(id);
    if (!row) return;
    const targets: Record<string, number> = {
      ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: ids.length - 1, PageDown: index + 5, PageUp: index - 5,
    };
    if (Object.hasOwn(targets, event.key)) {
      this.focusRow(ids[Math.max(0, Math.min(ids.length - 1, targets[event.key]))]);
    } else if (event.key === (this.tree.closest("[dir=rtl]") ? "ArrowLeft" : "ArrowRight")) {
      if (row.expanded === false) this.setBranch(id, true);
      else if (row.expanded) this.focusRow(row.firstChild);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      if (row.expanded) this.setBranch(id, false);
      else if (row.choice.parentId) this.focusRow(row.choice.parentId);
    } else if (event.key === " " || event.key === "Enter") {
      if (row.selectable) this.toggle(id);
      else if (event.key === "Enter" && row.expanded !== undefined) this.setBranch(id, !row.expanded);
    } else {
      return;
    }
    event.preventDefault();
  }

  private focusRow(id?: string, scroll = true): void {
    if (this.active) this.rows.get(this.active)?.line.removeClass("is-active");
    this.active = id;
    const row = id ? this.rows.get(id) : undefined;
    if (row) {
      row.line.addClass("is-active");
      this.tree.setAttribute("aria-activedescendant", row.node.id);
      if (scroll) row.line.scrollIntoView({ block: "nearest", inline: "nearest" });
    } else {
      this.tree.removeAttribute("aria-activedescendant");
    }
  }
}
