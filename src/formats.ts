import { t } from "./i18n";
import { parse, stringify } from "yaml";
import { entries, validateBoard, type Board, type TaskItem } from "./board";

export type BoardFormat = "md" | "json";

interface RecordData {
  [key: string]: unknown;
}

export interface BoardDocument {
  board: Board;
  delimiter?: string;
  eol?: string;
}

const FRONTMATTER = /^\uFEFF?---\r?\n([\s\S]*?)^---[ \t]*(\r?\n|$)/m;
const TOKEN = /^[a-z0-9-]+$/;

export function boardFormat(extension: string): BoardFormat | undefined {
  const format = extension.toLowerCase();
  if (format === "md" || format === "json") return format;
}

function record(value: unknown): RecordData {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(t("Expected a metadata object."));
  }
  return value as RecordData;
}

function frontmatter(source: string): RegExpExecArray | null {
  const match = FRONTMATTER.exec(source);
  return match?.index === 0 ? match : null;
}

export function identifyBoard(source: string, format: BoardFormat): { id?: string; title?: string } | null {
  if (format === "json") {
    try {
      return identity(JSON.parse(source.replace(/^\uFEFF/, "")));
    } catch {
      return /"type"\s*:\s*"task-board"/.test(source) ? {} : null;
    }
  }
  const yaml = frontmatter(source)?.[1];
  if (!yaml) return null;
  try {
    return identity(parse(yaml, { maxAliasCount: 0 }));
  } catch {
    return /^type:\s*["']?task-board["']?\s*$/m.test(yaml) ? {} : null;
  }
}

function identity(value: unknown): { id?: string; title?: string } | null {
  if (!value || typeof value !== "object" || !("type" in value) || value.type !== "task-board") return null;
  const { id, title } = value as RecordData;
  return {
    id: typeof id === "string" ? id : undefined,
    title: typeof title === "string" ? title : undefined,
  };
}

function markerPrefix(delimiter: string): string {
  return `<!-- task-board:${delimiter}:`;
}

function readSections(body: string, delimiter: string, eol: string): Map<string, string> {
  const marker = new RegExp(`^${markerPrefix(delimiter)}([a-z0-9][a-z0-9-]*) -->\\r?\\n`, "gm");
  const matches = [...body.matchAll(marker)];
  if (body && matches[0]?.index !== 0) throw new Error(t("The body must start with an item marker."));
  const sections = new Map<string, string>();
  for (const [index, match] of matches.entries()) {
    const id = match[1];
    const end = matches[index + 1]?.index ?? body.length;
    const section = body.slice(match.index + match[0].length, end);
    const heading = /^#{2,3} [^\r\n]*\r?\n\r?\n/.exec(section);
    if (!heading || !section.endsWith(eol) || section.length < heading[0].length + eol.length) {
      throw new Error(t("Section \"{0}\" needs a heading, a blank line, and a trailing line break.", id));
    }
    if (sections.has(id)) throw new Error(t("Section \"{0}\" appears more than once.", id));
    sections.set(id, section.slice(heading[0].length, -eol.length));
  }
  return sections;
}

export function parseBoard(source: string, format: BoardFormat): BoardDocument {
  if (format === "json") return { board: validateBoard(JSON.parse(source.replace(/^\uFEFF/, ""))) };

  const match = frontmatter(source);
  if (!match) throw new Error(t("The board YAML frontmatter is missing or incomplete."));
  const { delimiter, ...metadata } = record(parse(match[1], { maxAliasCount: 0 }));
  if (metadata.schemaVersion !== 1) {
    throw new Error(t("Unsupported schema version ({0}).", String(metadata.schemaVersion)));
  }
  if (typeof delimiter !== "string" || !TOKEN.test(delimiter)) throw new Error(t("Invalid Markdown delimiter."));
  const eol = match[2] || "\n";
  const sections = readSections(source.slice(match[0].length), delimiter, eol);
  function attachDescription(value: unknown): RecordData {
    const item = record(value);
    if ("description" in item) throw new Error(t("Move the description from the frontmatter to the item section."));
    const id = item.id;
    if (typeof id !== "string" || !sections.has(id)) throw new Error(t("Missing Markdown section for \"{0}\".", String(id)));
    const description = sections.get(id);
    sections.delete(id);
    return { ...item, description };
  }
  if (!Array.isArray(metadata.tasks)) throw new Error(t("The tasks field must be a list."));
  metadata.tasks = metadata.tasks.map((value) => {
    const task = attachDescription(value);
    if (Array.isArray(task.subtasks)) task.subtasks = task.subtasks.map(attachDescription);
    return task;
  });
  if (sections.size) throw new Error(t("Sections without a corresponding frontmatter item ({0}).", [...sections.keys()].join(", ")));
  return { board: validateBoard(metadata), delimiter, eol };
}

function escapeHeading(title: string): string {
  return title.replace(/[\\&<>`*_{}[\]()#!|~=$]/g, "\\$&");
}

export function serializeBoard(board: Board, format: BoardFormat, document?: BoardDocument): string {
  validateBoard(board);
  if (format === "json") return JSON.stringify(board, null, 2) + "\n";

  const all = entries(board);
  let delimiter = document?.delimiter ?? crypto.randomUUID();
  while (all.some(({ item }) => item.description.includes(markerPrefix(delimiter)))) {
    delimiter = crypto.randomUUID();
  }
  const eol = document?.eol ?? "\n";
  function metadata({ description: _description, ...fields }: TaskItem) {
    return fields;
  }
  const tasks = board.tasks.map(({ subtasks, ...task }) => ({
    ...metadata(task),
    subtasks: subtasks.map(metadata),
  }));
  const yaml = stringify({ ...board, delimiter, tasks }, { lineWidth: 0 }).replaceAll("\n", eol);
  const body = all.map(({ item, parent }) =>
    `${markerPrefix(delimiter)}${item.id} -->${eol}${parent ? "###" : "##"} ${escapeHeading(item.title)}${eol}${eol}${item.description}${eol}`,
  ).join("");
  return `---${eol}${yaml}---${eol}${body}`;
}
