#!/usr/bin/env node
/**
 * Regenerates the physical data model from Convex's own schema definition.
 *
 * `src/convex/schema.ts` is the single source of truth. This script evaluates
 * it — bundled with esbuild so the TypeScript and the auth library's tables
 * both load — then writes the ER diagram, the table counts and the index list
 * into docs/data-model.md and docs/architecture.md, between marker comments.
 * Because the numbers come from the schema itself, editing a table field or
 * adding a table and re-running this keeps the docs true.
 *
 *   npm run docs:data-model          rewrite the generated sections
 *   npm run docs:data-model:check    exit 1 when they are stale (CI)
 */
import { build } from "esbuild";
import { authTables } from "@convex-dev/auth/server";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_DIR = join(ROOT, ".cache");
const SCHEMA_ENTRY = join(ROOT, "src/convex/schema.ts");
const DATA_MODEL_DOC = join(ROOT, "docs/data-model.md");
const ARCHITECTURE_DOC = join(ROOT, "docs/architecture.md");
const DIAGRAMS_HTML = join(ROOT, "docs/diagrams.html");

const DATA_BEGIN = "<!-- BEGIN GENERATED DATA MODEL -->";
const DATA_END = "<!-- END GENERATED DATA MODEL -->";
const COUNTS_BEGIN = "<!-- BEGIN GENERATED COUNTS -->";
const COUNTS_END = "<!-- END GENERATED COUNTS -->";

const checkOnly = process.argv.includes("--check");

/** Every ```mermaid block in a Markdown document, in order. */
function mermaidBlocks(markdown) {
  const blocks = [];
  const pattern = /```mermaid\n([\s\S]*?)```/g;
  let match = pattern.exec(markdown);
  while (match !== null) {
    blocks.push(match[1].trimEnd());
    match = pattern.exec(markdown);
  }
  return blocks;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * A browser page holding the same diagrams as the Markdown, so they can be
 * read (and saved) without a Markdown viewer that draws Mermaid. Generated
 * from the two docs, so it never says anything they don't.
 */
function renderDiagramsHtml(architectureDoc, dataModelDoc) {
  const architecture = mermaidBlocks(architectureDoc);
  const model = mermaidBlocks(dataModelDoc);
  const sections = [
    {
      title: "Architecture",
      caption:
        "Hosting, the browser, the Convex deployment and the external services it talks to. Dashed: sign-in and token refresh.",
      blocks: architecture.slice(0, 1),
    },
    {
      title: "Conceptual data model",
      caption: "The things the school works with, and how they relate.",
      blocks: model.slice(0, 1),
    },
    {
      title: "Physical data model",
      caption:
        "Every table, its fields, keys and references — generated from src/convex/schema.ts.",
      blocks: model.slice(1, 2),
    },
  ].filter((section) => section.blocks.length > 0);

  const body = sections
    .map(
      (section) => `  <section>
    <h2>${escapeHtml(section.title)}</h2>
    <p class="caption">${escapeHtml(section.caption)}</p>
${section.blocks
  .map((block) => `    <pre class="mermaid">${escapeHtml(block)}</pre>`)
  .join("\n")}
  </section>`,
    )
    .join("\n\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>NatyaVault diagrams</title>
<style>
  :root { color-scheme: light dark; --ink: #1f2328; --muted: #59636e; --card: #ffffff; --page: #f6f8fa; --line: #d1d9e0; }
  @media (prefers-color-scheme: dark) {
    :root { --ink: #e6edf3; --muted: #9198a1; --card: #0d1117; --page: #010409; --line: #30363d; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 40px 24px 64px; background: var(--page); color: var(--ink);
    font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
  header, main { max-width: 1400px; margin: 0 auto; }
  h1 { margin: 0 0 8px; font-size: 30px; letter-spacing: -0.01em; }
  .blurb { margin: 0 0 32px; color: var(--muted); max-width: 70ch; }
  h2 { margin: 0 0 4px; font-size: 20px; }
  .caption { margin: 0 0 16px; color: var(--muted); font-size: 14px; }
  section { margin: 0 0 40px; padding: 24px; background: var(--card);
    border: 1px solid var(--line); border-radius: 12px; overflow-x: auto; }
  pre.mermaid { margin: 0; text-align: center; }
  p.warning { margin: 32px 0 0; color: var(--muted); font-size: 13px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em; }
</style>
</head>
<body>
<header>
  <h1>NatyaVault diagrams</h1>
  <p class="blurb">Generated from <code>docs/architecture.md</code> and <code>docs/data-model.md</code>.
  Change the schema or the docs, run <code>npm run docs:data-model</code>, and this page follows.</p>
</header>
<main>
${body}
  <p class="warning">Diagrams draw with Mermaid from the jsDelivr CDN, so this page needs an internet connection to render.</p>
</main>
<script type="module">
  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
  mermaid.initialize({
    startOnLoad: true,
    maxTextSize: 400000,
    maxEdges: 2000,
    theme: window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default",
    // Draw at natural size and let the card scroll: the ER diagram is far too
    // wide to squeeze into a column without becoming unreadable.
    flowchart: { useMaxWidth: false },
    er: { useMaxWidth: false },
  });
</script>
</body>
</html>
`;
}

/** Text that is safe inside a Mermaid quoted comment. */
function quote(text) {
  return `"${String(text).replace(/"/g, "'").replace(/\s+/g, " ").trim()}"`;
}

/** Map a Convex validator to a Mermaid ER attribute type plus a note. */
function fieldType(validator) {
  const kind = validator?.kind ?? "any";
  switch (kind) {
    case "string":
      return { type: "string", note: null };
    case "number":
    case "float64":
      return { type: "number", note: null };
    case "int64":
      return { type: "int64", note: null };
    case "boolean":
      return { type: "bool", note: null };
    case "bytes":
      return { type: "bytes", note: null };
    case "id":
      return { type: "id", note: `-> ${validator.tableName}` };
    case "literal":
      return { type: "enum", note: String(validator.value) };
    case "array": {
      const inner = fieldType(validator.element);
      return { type: "array", note: inner.note ? `${inner.type} ${inner.note}` : inner.type };
    }
    case "object":
      return { type: "object", note: Object.keys(validator.fields ?? {}).join(", ") };
    case "record":
      return { type: "map", note: null };
    case "union": {
      const members = validator.members ?? [];
      const literals = members.every((member) => member.kind === "literal");
      const notes = members.map((member) =>
        member.kind === "literal" ? String(member.value) : fieldType(member).type,
      );
      return { type: literals ? "enum" : "union", note: notes.join(", ") };
    }
    default:
      return { type: "any", note: kind === "any" ? null : kind };
  }
}

/** One `erDiagram` covering every table and every reference. */
function renderDiagram(tables) {
  const lines = ["erDiagram"];
  const relations = [];
  for (const [name, definition] of Object.entries(tables)) {
    const fields = definition.validator?.fields ?? {};
    lines.push(`  ${name} {`);
    lines.push("    id _id PK");
    lines.push("    number _creationTime");
    for (const [field, validator] of Object.entries(fields)) {
      const { type, note } = fieldType(validator);
      const foreign = validator?.kind === "id";
      const bits = [];
      if (note) bits.push(note);
      if (validator?.isOptional === "optional") bits.push("optional");
      const key = foreign ? " FK" : "";
      const suffix = bits.length ? ` ${quote(bits.join("; "))}` : "";
      lines.push(`    ${type} ${field}${key}${suffix}`);
      if (foreign) {
        relations.push(`  ${validator.tableName} ||--o{ ${name} : ${quote(field)}`);
      }
    }
    lines.push("  }");
  }
  return [...lines, ...relations].join("\n");
}

/** Every declared index, as a Markdown table. */
function renderIndexes(tables) {
  const rows = [];
  for (const [name, definition] of Object.entries(tables)) {
    const indexes = (definition.indexes ?? []).map(
      (index) => `\`${index.indexDescriptor}(${index.fields.join(", ")})\``,
    );
    if (indexes.length > 0) rows.push(`| \`${name}\` | ${indexes.join(", ")} |`);
  }
  return ["| table | indexes |", "| --- | --- |", ...rows].join("\n");
}

/** How many tables there are, and where each group comes from. */
function countTables(tables) {
  const total = Object.keys(tables).length;
  const authOnly = Object.keys(authTables).filter(
    (name) => name !== "users" && tables[name],
  );
  return { total, primary: total - authOnly.length, authOnly };
}

function renderDataModel(tables) {
  const { total, primary, authOnly } = countTables(tables);
  return [
    `**${total} tables** — ${primary} defined in \`src/convex/schema.ts\` (including`,
    `\`users\`) plus ${authOnly.length} from Convex Auth's \`authTables\` (${authOnly
      .map((name) => `\`${name}\``)
      .join(", ")}).`,
    "",
    "```mermaid",
    renderDiagram(tables),
    "```",
    "",
    "### Indexes",
    "",
    renderIndexes(tables),
  ].join("\n");
}

function renderCounts(tables) {
  const { total, primary, authOnly } = countTables(tables);
  return [
    `The deployment has **${total} tables** — ${primary} defined in`,
    `\`src/convex/schema.ts\` (including \`users\`) and ${authOnly.length} more that`,
    "Convex Auth adds.",
    "",
    "Field-level detail, references and indexes live in [data-model.md](data-model.md).",
    "This count is generated from the schema, not typed by hand.",
  ].join("\n");
}

/** Replace the text between two markers, or explain which doc is missing them. */
async function writeSection(path, begin, end, body) {
  const current = await readFile(path, "utf8");
  const from = current.indexOf(begin);
  const to = current.indexOf(end);
  if (from === -1 || to === -1 || to < from) {
    throw new Error(`${path} is missing the ${begin} / ${end} markers`);
  }
  const next = `${current.slice(0, from + begin.length)}\n${body}\n${current.slice(to)}`;
  if (next === current) return { path, changed: false, stale: false };
  if (checkOnly) return { path, changed: false, stale: true };
  await writeFile(path, next, "utf8");
  return { path, changed: true, stale: false };
}

/** Write a wholly generated file (no markers), same update/check contract. */
async function writeGenerated(path, content) {
  let current = null;
  try {
    current = await readFile(path, "utf8");
  } catch {
    current = null;
  }
  if (current === content) return { path, changed: false, stale: false };
  if (checkOnly) return { path, changed: false, stale: true };
  await writeFile(path, content, "utf8");
  return { path, changed: true, stale: false };
}

await mkdir(CACHE_DIR, { recursive: true });
const bundled = join(CACHE_DIR, "schema.mjs");
await build({
  entryPoints: [SCHEMA_ENTRY],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: bundled,
  packages: "external",
  logLevel: "silent",
});

const schema = (await import(`${bundled}?t=${Date.now()}`)).default;
const tables = schema.tables ?? {};
if (Object.keys(tables).length === 0) {
  throw new Error("The schema exported no tables");
}

const results = [
  await writeSection(DATA_MODEL_DOC, DATA_BEGIN, DATA_END, renderDataModel(tables)),
  await writeSection(ARCHITECTURE_DOC, COUNTS_BEGIN, COUNTS_END, renderCounts(tables)),
  await writeGenerated(
    DIAGRAMS_HTML,
    renderDiagramsHtml(
      await readFile(ARCHITECTURE_DOC, "utf8"),
      await readFile(DATA_MODEL_DOC, "utf8"),
    ),
  ),
];

const { total } = countTables(tables);
for (const result of results) {
  const state = result.changed ? "updated" : result.stale ? "STALE" : "unchanged";
  console.log(`${state.padEnd(9)} ${result.path.replace(`${ROOT}/`, "")}`);
}
console.log(`${total} tables read from src/convex/schema.ts`);

if (results.some((result) => result.stale)) {
  console.error("\nDocs are out of date — run: npm run docs:data-model");
  process.exit(1);
}
