import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import Ajv from "ajv";
import standalone from "ajv/dist/standalone/index.js";
import { build } from "esbuild";

const schema = JSON.parse(await readFile("docs/board.schema.json", "utf8"));
const ajv = new Ajv({ allErrors: true, code: { source: true, lines: true } });
const validator = standalone(ajv, ajv.compile(schema));
const boardValidator = {
  name: "board-validator",
  setup(builder) {
    builder.onResolve({ filter: /^\.\/board-validator$/ }, () => ({
      path: "board-validator",
      namespace: "trama",
    }));
    builder.onLoad({ filter: /.*/, namespace: "trama" }, () => ({
      contents: validator,
      loader: "js",
      resolveDir: import.meta.dirname,
    }));
  },
};

const testing = process.argv.includes("--test");
const result = await build({
  entryPoints: [testing ? "tests/board.test.ts" : "src/main.ts"],
  outfile: testing ? ".test-build/board.test.cjs" : "dist/main.js",
  bundle: true,
  platform: testing ? "node" : "browser",
  format: "cjs",
  target: "es2022",
  external: ["obsidian"],
  plugins: [boardValidator],
  metafile: !testing,
  write: testing,
});

if (!testing) {
  // Credit Ajv for the generated validator as well as packages with code in the bundle.
  const packages = new Set(["ajv"]);
  for (const input of Object.keys(result.metafile.outputs["dist/main.js"].inputs)) {
    const match = /^node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
    if (match) packages.add(match[1]);
  }
  const notices = await Promise.all([...packages].sort().map(async (name) => {
    const license = await readFile(`node_modules/${name}/LICENSE`, "utf8");
    return `${name}\n${license.trimEnd()}`;
  }));
  const license = await readFile("LICENSE", "utf8");
  const banner = [license.trimEnd(), "Third-party licenses", ...notices].join("\n\n")
    .split(/\r?\n/).map((line) => line ? `// ${line}` : "//").join("\n");
  await mkdir("dist", { recursive: true });
  await Promise.all([
    writeFile("dist/main.js", `${banner}\n\n${result.outputFiles[0].text}`),
    ...["manifest.json", "styles.css"].map((name) => copyFile(name, `dist/${name}`)),
  ]);
}
