import { t } from "./i18n";
import validateShape from "./board-validator";

export interface Status {
  id: string;
  title: string;
  done: boolean;
}

export interface ItemFields {
  title: string;
  description: string;
  status: string;
  dependsOn: string[];
  git?: { branch?: string; commit?: string };
}

export interface TaskItem extends ItemFields {
  id: string;
}

export interface Task extends TaskItem {
  archived?: boolean;
  subtasks: TaskItem[];
}

export interface Board {
  type: "task-board";
  schemaVersion: 1;
  id: string;
  title: string;
  statuses: Status[];
  tasks: Task[];
}

export interface Entry {
  item: TaskItem;
  task: Task;
  parent?: Task;
}

export type Mutation = (board: Board) => void;

export function createBoard(title: string): Board {
  return {
    type: "task-board",
    schemaVersion: 1,
    id: crypto.randomUUID(),
    title,
    statuses: [
      { id: "todo", title: t("To do"), done: false },
      { id: "doing", title: t("In progress"), done: false },
      { id: "done", title: t("Completed"), done: true },
    ],
    tasks: [],
  };
}

export function entries(board: Board): Entry[] {
  return board.tasks.flatMap((task) => [
    { item: task, task },
    ...task.subtasks.map((item) => ({ item, task, parent: task })),
  ]);
}

export function requireEntry(board: Board, id: string): Entry {
  const entry = entries(board).find(({ item }) => item.id === id);
  if (!entry) throw new Error(t("Item \"{0}\" is no longer on the board.", id));
  return entry;
}

function acceptsDependency(target: Entry, parentId?: string): boolean {
  return !target.parent || target.parent.id === parentId;
}

export function dependencyCandidates(board: Board, itemId?: string, parentId?: string) {
  const all = entries(board);
  const wouldCycle = new Set<string>();
  if (itemId) {
    const dependents = new Map<string, string[]>();
    for (const { item } of all) {
      for (const dependency of item.dependsOn) {
        const list = dependents.get(dependency) ?? [];
        list.push(item.id);
        dependents.set(dependency, list);
      }
    }
    const queue = [itemId];
    wouldCycle.add(itemId);
    for (let index = 0; index < queue.length; index++) {
      for (const id of dependents.get(queue[index]) ?? []) {
        if (wouldCycle.has(id)) continue;
        wouldCycle.add(id);
        queue.push(id);
      }
    }
  }
  return all.filter((entry) => entry.item.id !== itemId && acceptsDependency(entry, parentId))
    .map((entry) => ({ ...entry, wouldCycle: wouldCycle.has(entry.item.id) }));
}

export function validateBoard(value: unknown): Board {
  if (value && typeof value === "object" && "schemaVersion" in value && value.schemaVersion !== 1) {
    throw new Error(t("Unsupported schema version ({0}).", String(value.schemaVersion)));
  }
  if (!validateShape(value)) {
    const errors = validateShape.errors?.slice(0, 5).map((error) => {
      const field: unknown = error.params.missingProperty ?? error.params.additionalProperty;
      return `${error.instancePath || "/"}${typeof field === "string" && field ? ` [${field}]` : ""} (${error.keyword})`;
    });
    throw new Error(t("Invalid board fields. {0}", errors?.join(", ")));
  }

  const statuses = new Set(value.statuses.map(({ id }) => id));
  if (statuses.size !== value.statuses.length) throw new Error(t("Duplicate status IDs."));
  const all = entries(value);
  const byId = new Map(all.map((entry) => [entry.item.id, entry]));
  if (byId.size !== all.length) throw new Error(t("Duplicate item IDs."));

  const incoming = new Map<string, string[]>();
  const pending = new Map<string, number>();
  for (const { item, parent } of all) {
    if (!statuses.has(item.status)) throw new Error(t("Unknown status for \"{0}\".", item.title));
    pending.set(item.id, item.dependsOn.length);
    for (const id of item.dependsOn) {
      const target = byId.get(id);
      if (!target || id === item.id || !acceptsDependency(target, parent?.id)) {
        throw new Error(t("Invalid dependency \"{0}\" for \"{1}\".", id, item.title));
      }
      const dependents = incoming.get(id) ?? [];
      dependents.push(item.id);
      incoming.set(id, dependents);
    }
  }

  const ready = all.filter(({ item }) => item.dependsOn.length === 0).map(({ item }) => item.id);
  for (let index = 0; index < ready.length; index++) {
    for (const dependent of incoming.get(ready[index]) ?? []) {
      const remaining = (pending.get(dependent) ?? 0) - 1;
      pending.set(dependent, remaining);
      if (remaining === 0) ready.push(dependent);
    }
  }
  if (ready.length !== all.length) throw new Error(t("Dependencies form a cycle."));
  return value;
}

function same(before: unknown, after: unknown): boolean {
  if (before === after) return true;
  if (Array.isArray(before) && Array.isArray(after)) {
    return before.length === after.length && before.every((value, index) => same(value, after[index]));
  }
  if (before && after && typeof before === "object" && typeof after === "object") {
    const keys = Object.keys(before) as (keyof typeof before)[];
    return keys.length === Object.keys(after).length &&
      keys.every((key) => Object.hasOwn(after, key) && same(before[key], after[key]));
  }
  return false;
}

export function updateItem(board: Board, id: string, base: ItemFields, edited: ItemFields): void {
  const { item } = requireEntry(board, id);
  const patch: Partial<ItemFields> = {};
  for (const field of ["title", "description", "status", "dependsOn"] as const) {
    if (same(base[field], edited[field])) continue;
    if (!same(item[field], base[field]) && !same(item[field], edited[field])) {
      throw new Error(t("The \"{0}\" field of \"{1}\" changed. Your draft is still available.", field, item.title));
    }
    Object.assign(patch, { [field]: edited[field] });
  }
  const git = { ...item.git };
  for (const field of ["branch", "commit"] as const) {
    if (base.git?.[field] === edited.git?.[field]) continue;
    if (git[field] !== base.git?.[field] && git[field] !== edited.git?.[field]) {
      throw new Error(t("The \"{0}\" field of \"{1}\" changed. Your draft is still available.", field, item.title));
    }
    const value = edited.git?.[field];
    if (value) git[field] = value;
    else delete git[field];
  }
  Object.assign(item, patch);
  if (Object.keys(git).length) item.git = git;
  else delete item.git;
}

export function deletionImpact(board: Board, id: string) {
  const entry = requireEntry(board, id);
  const removed = entry.parent ? [entry.item] : [entry.task, ...entry.task.subtasks];
  const ids = new Set(removed.map((item) => item.id));
  const links = entries(board).flatMap(({ item }) => item.dependsOn
    .filter((target) => ids.has(item.id) || ids.has(target))
    .map((target) => ({ from: item.id, to: target })));
  return {
    removed: removed.map(({ id, title }) => ({ id, title })).sort((a, b) => a.id.localeCompare(b.id)),
    links: links.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
  };
}

export function deleteItem(board: Board, id: string, confirmed: ReturnType<typeof deletionImpact>): void {
  if (!same(confirmed, deletionImpact(board, id))) {
    throw new Error(t("The items or links changed. Open the confirmation again."));
  }
  const { parent } = requireEntry(board, id);
  if (parent) parent.subtasks = parent.subtasks.filter((item) => item.id !== id);
  else board.tasks = board.tasks.filter((task) => task.id !== id);
  const removed = new Set(confirmed.removed.map((item) => item.id));
  for (const { item } of entries(board)) item.dependsOn = item.dependsOn.filter((target) => !removed.has(target));
}

export function updateStatuses(
  board: Board,
  base: Status[],
  statuses: Status[],
  replacements: ReadonlyMap<string, string>,
): void {
  if (!same(board.statuses, base)) {
    throw new Error(t("Board statuses changed. Reopen status settings to edit the current list."));
  }
  const remaining = new Set(statuses.map(({ id }) => id));
  for (const { item } of entries(board)) {
    if (remaining.has(item.status)) continue;
    const replacement = replacements.get(item.status);
    if (!replacement || !remaining.has(replacement)) {
      throw new Error(t("Choose a replacement status for \"{0}\".", item.title));
    }
    item.status = replacement;
  }
  board.statuses = statuses;
}
