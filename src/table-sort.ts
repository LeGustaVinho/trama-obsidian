import { getLocale } from "./i18n";
import type { Status, TaskItem } from "./board";

export const TABLE_COLUMNS = [
  { key: "title", title: "Title", sortLabel: "title" },
  { key: "status", title: "Status", sortLabel: "status order" },
  { key: "dependsOn", title: "Dependencies", sortLabel: "number of dependencies" },
  { key: "branch", title: "Branch", sortLabel: "Git branch" },
  { key: "commit", title: "Commit", sortLabel: "Git commit" },
] as const;

type Column = typeof TABLE_COLUMNS[number]["key"];
export interface TableSort {
  column: Column;
  direction: "ascending" | "descending";
}

export function readTableSort(value: unknown): TableSort | undefined {
  if (!value || typeof value !== "object" || !("column" in value && "direction" in value)) return;
  const { column, direction } = value;
  const match = TABLE_COLUMNS.find(({ key }) => key === column);
  if (match && (direction === "ascending" || direction === "descending")) return { column: match.key, direction };
}

export function nextTableSort(column: Column, current?: TableSort): TableSort | undefined {
  if (current?.column !== column) return { column, direction: "ascending" };
  if (current.direction === "ascending") return { column, direction: "descending" };
}

export function tableComparator({ column, direction }: TableSort, statuses: readonly Status[]) {
  const textOrder = new Intl.Collator(getLocale(), { numeric: true, sensitivity: "base" });
  const ranks = new Map(statuses.map((status, index) => [status.id, index]));
  const fields: Record<Column, (item: TaskItem) => string | number | undefined> = {
    title: (item) => item.title,
    status: (item) => ranks.get(item.status),
    dependsOn: (item) => item.dependsOn.length,
    branch: (item) => item.git?.branch,
    commit: (item) => item.git?.commit,
  };
  const field = fields[column];
  const multiplier = direction === "ascending" ? 1 : -1;
  return (first: TaskItem, second: TaskItem): number => {
    const a = field(first);
    const b = field(second);
    if (a === b) return 0;
    if (a === undefined) return 1;
    if (b === undefined) return -1;
    const order = typeof a === "number" && typeof b === "number" ? a - b : textOrder.compare(String(a), String(b));
    return multiplier * order;
  };
}
