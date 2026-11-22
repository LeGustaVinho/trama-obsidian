import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createBoard, deleteItem, deletionImpact, dependencyCandidates, entries, requireEntry, updateItem, updateStatuses, validateBoard,
} from "../src/board";
import { identifyBoard, parseBoard, serializeBoard } from "../src/formats";
import { getLocale, languageAttributes, setLocale, supportedLocales, t } from "../src/i18n";
import { nextTableSort, readTableSort, tableComparator } from "../src/table-sort";

const markdown = readFileSync("docs/examples/board-md.md", "utf8").replace(/\r\n/g, "\n");
const json = readFileSync("docs/examples/board-json.json", "utf8");
const sample = () => parseBoard(json, "json").board;
setLocale("pt-BR");

test("todos os idiomas do Obsidian têm as mesmas mensagens e variáveis", () => {
  const expected = "am ar be bg bn ca cs da de el en en-GB es fa fi fr ga gl he hu id it ja ka kab km ko lv ms ne nl no pl pt pt-BR ro ru sa si sk sq sr sv ta th tr uk uz vi zh zh-TW".split(" ").sort();
  assert.deepEqual(supportedLocales, expected);
  const read = (code: string): Record<string, string> =>
    JSON.parse(readFileSync(`src/locales/${code === "en-GB" ? "en" : code}.json`, "utf8"));
  const english = read("en");
  const markers = (value: string) => (value.match(/\{\d+\}/g) ?? []).sort();
  for (const code of supportedLocales) {
    const catalog = read(code);
    assert.deepEqual(Object.keys(catalog).sort(), Object.keys(english).sort(), code);
    for (const [message, translated] of Object.entries(catalog)) {
      assert.ok(translated.trim(), `${code}: ${message}`);
      assert.deepEqual(markers(translated), markers(english[message]), `${code}: ${message}`);
    }
  }
});

test("localiza a interface e os status novos sem traduzir dados existentes", () => {
  try {
    setLocale("fr");
    assert.equal(t("New column"), "Nouvelle colonne");
    assert.equal(createBoard("Mon titre").title, "Mon titre");
    assert.deepEqual(createBoard("Mon titre").statuses.map(({ title }) => title), ["À faire", "En cours", "Terminée"]);
    assert.equal(sample().statuses[0].title, "A fazer");
    setLocale("ar");
    assert.deepEqual(languageAttributes(), { lang: "ar", dir: "rtl" });
    const count = new Intl.NumberFormat("ar", { useGrouping: false }).format(3);
    assert.ok(t("Completed tasks: {0}/{1}", 3, 7).includes(count));
    setLocale("zh-Hant");
    assert.equal(getLocale(), "zh-TW");
    setLocale("unknown");
    assert.equal(t("New column"), "New column");
  } finally {
    setLocale("pt-BR");
  }
});

test("os dois exemplos publicados contêm os mesmos itens, vínculos, status e descrições", () => {
  const md = parseBoard(markdown, "md");
  const board = sample();
  assert.deepEqual({ ...md.board, id: board.id }, board);
  assert.deepEqual(parseBoard(serializeBoard(md.board, "md", md), "md").board, md.board);
  assert.deepEqual(parseBoard(serializeBoard(board, "json"), "json").board, board);
  assert.equal(requireEntry(board, "revisar").parent?.id, "avaliar");
  assert.equal(requireEntry(board, "prototipo").task.archived, true);
});

test("grava boards vazios, preserva Markdown arbitrário e troca delimitadores em colisão", () => {
  const empty = createBoard("Vazio");
  assert.deepEqual(parseBoard(serializeBoard(empty, "md"), "md").board, empty);
  const document = parseBoard(markdown.replaceAll("\n", "\r\n"), "md");
  const first = document.board.tasks[0];
  first.description = "\n## Cabeçalho\r\n> [!tip]\n> Fim\n\n" +
    "````text\r\n<!-- task-board:entrega-v1:avaliar -->\r\n````";
  first.subtasks[0].description = "";
  first.subtasks[1].description = "Sem descrição?\n\n";
  const serialized = parseBoard(serializeBoard(document.board, "md", document), "md");
  assert.notEqual(serialized.delimiter, document.delimiter);
  assert.deepEqual(serialized.board, document.board);
});

test("mover subtarefa em Markdown preserva descrição e status do pai", () => {
  const document = parseBoard(markdown, "md");
  const { board } = document;
  const descriptions = entries(board).map(({ item }) => item.description);
  const { item, task } = requireEntry(board, "revisar");
  updateItem(board, item.id, item, { ...item, status: "doing" });
  const reloaded = parseBoard(serializeBoard(board, "md", document), "md").board;
  assert.deepEqual(entries(reloaded).map(({ item }) => item.description), descriptions);
  assert.equal(requireEntry(reloaded, "revisar").item.status, "doing");
  assert.equal(requireEntry(reloaded, task.id).item.status, task.status);
});

test("reconhece boards e rejeita versões, relações inválidas e seções faltantes", () => {
  assert.equal(identifyBoard(markdown, "md")?.id, "entrega-markdown");
  assert.equal(identifyBoard(json, "json")?.id, "entrega-json");
  assert.equal(identifyBoard("# Nota\n\n```yaml\ntype: task-board\n```", "md"), null);
  assert.equal(identifyBoard('{"unrelated": {"type": "task-board"}}', "json"), null);
  assert.throws(() => parseBoard(json.replace('"schemaVersion": 1', '"schemaVersion": 2'), "json"), /Versão/);
  assert.throws(() => parseBoard(markdown.replace("entrega-v1:avaliar -->", "entrega-v1:outra -->"), "md"), /ausente/);
  const board = sample();
  const target = requireEntry(board, "preparar").item;
  target.dependsOn = ["revisar"];
  assert.throws(() => validateBoard(board), /inválida/);
  target.dependsOn = ["nao-existe"];
  assert.throws(() => validateBoard(board), /inválida/);
  target.dependsOn = ["avaliar"];
  assert.throws(() => validateBoard(board), /ciclo/);
});

test("o seletor respeita o escopo de subtarefas e identifica ciclos transitivos", () => {
  const board = sample();
  requireEntry(board, "prototipo").item.dependsOn = ["avaliar"];
  board.tasks.push({
    id: "publicar", title: "Publicar", status: "todo", description: "", dependsOn: ["prototipo"],
    subtasks: [{ id: "anunciar", title: "Anunciar", status: "todo", description: "", dependsOn: [] }],
  });
  validateBoard(board);
  const taskOptions = dependencyCandidates(board, "avaliar");
  assert.deepEqual(taskOptions.map(({ item }) => item.id), ["preparar", "prototipo", "publicar"]);
  assert.deepEqual(taskOptions.filter(({ wouldCycle }) => wouldCycle).map(({ item }) => item.id), ["prototipo", "publicar"]);
  const subtaskOptions = dependencyCandidates(board, "testar", "avaliar");
  assert.equal(subtaskOptions.some(({ item }) => item.id === "avaliar"), true);
  assert.equal(subtaskOptions.some(({ item }) => item.id === "anunciar"), false);
  assert.equal(subtaskOptions.find(({ item }) => item.id === "revisar")?.wouldCycle, true);
});

test("ordena a tabela por texto, status, vínculos e Git com campos vazios no fim", () => {
  const board = sample();
  const items = [
    { id: "dez", title: "Épico 10", status: "done", dependsOn: ["a", "b"], description: "" },
    { id: "dois", title: "Épico 2", status: "todo", dependsOn: [], description: "", git: { branch: "main", commit: "fc" } },
    { id: "um", title: "Epico 1", status: "doing", dependsOn: ["c"], description: "", git: { branch: "dev", commit: "ab" } },
  ];
  const sorted = (column: Parameters<typeof nextTableSort>[0], direction: "ascending" | "descending" = "ascending") =>
    [...items].sort(tableComparator({ column, direction }, board.statuses)).map(({ id }) => id);
  assert.deepEqual(sorted("title"), ["um", "dois", "dez"]);
  assert.deepEqual(sorted("status"), ["dois", "um", "dez"]);
  assert.deepEqual(sorted("dependsOn", "descending"), ["dez", "um", "dois"]);
  assert.deepEqual(sorted("branch"), ["um", "dois", "dez"]);
  assert.deepEqual(sorted("commit", "descending"), ["dois", "um", "dez"]);
  const first = nextTableSort("title");
  const second = nextTableSort("title", first);
  assert.deepEqual(readTableSort(second), { column: "title", direction: "descending" });
  assert.equal(nextTableSort("title", second), undefined);
  assert.equal(readTableSort({ column: "unsupported", direction: "ascending" }), undefined);
});

test("arquivamento preserva vínculos e exclusão limpa só os registros e vínculos necessários", () => {
  const board = sample();
  const task = requireEntry(board, "avaliar").task;
  task.archived = true;
  assert.equal(requireEntry(board, "testar").task.archived, true);
  assert.equal(requireEntry(board, "revisar").item.dependsOn[0], "testar");
  const preparing = requireEntry(board, "preparar").item;
  preparing.dependsOn = [];
  const impact = deletionImpact(board, preparing.id);
  deleteItem(board, preparing.id, impact);
  assert.deepEqual(task.dependsOn, []);
  assert.deepEqual(requireEntry(board, "revisar").item.dependsOn, ["testar"]);
  deleteItem(board, "testar", deletionImpact(board, "testar"));
  assert.deepEqual(requireEntry(board, "revisar").item.dependsOn, []);
  deleteItem(board, "avaliar", deletionImpact(board, "avaliar"));
  assert.deepEqual(board.tasks.map(({ id }) => id), ["prototipo"]);
  validateBoard(board);
});

test("edições simultâneas preservam campos independentes e detectam conflito antes de aplicar", () => {
  const base = requireEntry(sample(), "avaliar").item;
  const latest = sample();
  const { item } = requireEntry(latest, base.id);
  item.description = "Editado na fonte.";
  item.git = { ...item.git, commit: "outro" };
  updateItem(latest, base.id, base, { ...base, status: "done", git: { ...base.git, branch: "feature/revisao" } });
  assert.equal(item.description, "Editado na fonte.");
  assert.deepEqual(item.git, { branch: "feature/revisao", commit: "outro" });
  assert.throws(() => updateItem(latest, base.id, base, { ...base, title: "Novo título", description: "Rascunho" }), /Conflito/);
  assert.equal(item.title, base.title);
  assert.equal(item.status, "done");
});

test("remoção de status substitui todas as referências, inclusive arquivadas", () => {
  const board = sample();
  const base = board.statuses;
  const statuses = base.filter(({ id }) => id !== "done").reverse();
  assert.throws(() => updateStatuses(board, base, statuses, new Map()), /substituto/);
  updateStatuses(board, base, statuses, new Map([["done", "todo"]]));
  assert.equal(requireEntry(board, "prototipo").item.status, "todo");
  assert.equal(requireEntry(board, "testar").item.status, "todo");
  assert.deepEqual(board.statuses.map(({ id }) => id), ["doing", "todo"]);
  validateBoard(board);
});
