#!/usr/bin/env node
/**
 * Regenerates the data model docs from Convex's own schema definition.
 *
 * `src/convex/schema.ts` is the single source of truth. This script evaluates
 * it — bundled with esbuild so the TypeScript and the auth library's tables
 * both load — then writes, between marker comments:
 *
 *   docs/data-model.md      one ER diagram per domain, plus the index list
 *   docs/architecture.md    the table count
 *   docs/diagrams.html      the same diagrams for a browser, with a
 *                           "Download SVG" button on each one
 *
 * The physical model is split by domain so no diagram is a 27-table row.
 * Every table must belong to exactly one domain: add a table to the schema and
 * this script fails until it is assigned, which is what keeps the split honest.
 *
 *   npm run docs:data-model          rewrite the generated sections
 *   npm run docs:data-model:check    exit 1 when docs or SVGs are stale (CI)
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
const SVG_DIR = join(ROOT, "docs/diagrams");

const DATA_BEGIN = "<!-- BEGIN GENERATED DATA MODEL -->";
const DATA_END = "<!-- END GENERATED DATA MODEL -->";
const COUNTS_BEGIN = "<!-- BEGIN GENERATED COUNTS -->";
const COUNTS_END = "<!-- END GENERATED COUNTS -->";

const checkOnly = process.argv.includes("--check");

/**
 * One domain model each. Every table in the schema has to appear exactly once;
 * the script stops if one is missing or listed twice, so a new table cannot
 * quietly drop out of the diagrams.
 */
const DOMAINS = [
  {
    id: "identity",
    title: "Accounts and auth",
    blurb: "Who can sign in. The `users` row is the account; everything else here is Convex Auth's own bookkeeping.",
    tables: [
      "users",
      "authAccounts",
      "authSessions",
      "authRefreshTokens",
      "authVerificationCodes",
      "authVerifiers",
      "authRateLimits",
    ],
  },
  {
    id: "admin",
    title: "Admin and settings",
    blurb: "The admin's own records: passwords captured at sign-up for the reset screen, the 90-day unlocks, and the deployment-wide feature switches.",
    tables: ["savedPasswords", "adminUnlocks", "settings"],
  },
  {
    id: "classes",
    title: "Classes and people",
    blurb: "A class is created by a teacher and joined by students with its six-character code; `classStudents` holds names a teacher added by hand.",
    tables: ["classes", "classMembers", "classStudents"],
  },
  {
    id: "learning",
    title: "Attendance and practice",
    blurb: "The two per-class records students and teachers both read: marks per class day, and practice sessions.",
    tables: ["attendanceMarks", "practiceEntries"],
  },
  {
    id: "media",
    title: "Media and Google Drive",
    blurb: "Metadata for every upload, the short-lived playback grants, and the Drive connections the bytes are actually stored in.",
    tables: [
      "vaultMedia",
      "mediaGrants",
      "driveFiles",
      "driveStates",
      "driveTokens",
      "vaultDriveTokens",
    ],
  },
  {
    id: "chat",
    title: "Chat, calls and notifications",
    blurb: "Rooms, who sits in them, the messages, read markers, live calls, and the browsers that receive push.",
    tables: [
      "chats",
      "chatMembers",
      "chatMessages",
      "chatReads",
      "calls",
      "pushSubscriptions",
    ],
  },
];

/** 32-bit FNV-1a, in hex. Matches the copy in the generated page. */
function hashSource(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
      return {
        type: "array",
        note: inner.note ? `${inner.type} ${inner.note}` : inner.type,
      };
    }
    case "object":
      return {
        type: "object",
        note: Object.keys(validator.fields ?? {}).join(", "),
      };
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

/**
 * One domain's `erDiagram`: its tables, their fields, and the references that
 * stay inside the domain. References to another domain are returned
 * separately, to be printed under the diagram rather than drawn across it.
 */
function renderDomain(tables, domain) {
  const lines = ["erDiagram"];
  const relations = [];
  const external = new Set();

  for (const name of domain.tables) {
    const definition = tables[name];
    const fields = definition?.validator?.fields ?? {};
    lines.push(`  ${name} {`);
    lines.push("    id _id PK");
    lines.push("    number _creationTime");
    for (const [field, validator] of Object.entries(fields)) {
      const { type, note } = fieldType(validator);
      const foreign = validator?.kind === "id";
      const bits = [];
      if (note) bits.push(note);
      if (validator?.isOptional === "optional") bits.push("optional");
      const suffix = bits.length ? ` ${quote(bits.join("; "))}` : "";
      lines.push(`    ${type} ${field}${foreign ? " FK" : ""}${suffix}`);
      if (foreign) {
        if (domain.tables.includes(validator.tableName)) {
          relations.push(
            `  ${validator.tableName} ||--o{ ${name} : ${quote(field)}`,
          );
        } else {
          external.add(validator.tableName);
        }
      }
    }
    lines.push("  }");
  }

  return { source: [...lines, ...relations].join("\n"), external };
}

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

/** How many tables there are, and where each group comes from. */
function countTables(tables) {
  const total = Object.keys(tables).length;
  const authOnly = Object.keys(authTables).filter(
    (name) => name !== "users" && tables[name],
  );
  return { total, primary: total - authOnly.length, authOnly };
}

/**
 * Check every table is in exactly one domain, which is what makes the split
 * complete rather than lucky.
 */
function assignDomains(tables) {
  const seen = new Map();
  for (const domain of DOMAINS) {
    for (const name of domain.tables) {
      if (!tables[name]) {
        throw new Error(`Domain "${domain.id}" lists a table that does not exist: ${name}`);
      }
      if (seen.has(name)) {
        throw new Error(`Table "${name}" is in both "${seen.get(name)}" and "${domain.id}"`);
      }
      seen.set(name, domain.id);
    }
  }
  const missing = Object.keys(tables).filter((name) => !seen.has(name));
  if (missing.length > 0) {
    throw new Error(
      `These tables are in no domain, so they would be missing from the docs: ${missing.join(", ")}\nAdd them to a domain in scripts/generate-data-model.mjs`,
    );
  }
}

function buildDiagramList(tables, architectureSource, conceptualSource) {
  const diagrams = [
    {
      id: "architecture",
      title: "Architecture",
      caption:
        "Hosting, the browser, the Convex deployment and the external services it talks to. Dashed: sign-in and token refresh.",
      source: architectureSource,
    },
    {
      id: "conceptual-model",
      title: "Conceptual data model",
      caption: "The things the school works with, and how they relate.",
      source: conceptualSource,
    },
  ];

  for (const domain of DOMAINS) {
    const { source, external } = renderDomain(tables, domain);
    const refs = [...external].sort();
    diagrams.push({
      id: domain.id,
      title: domain.title,
      caption:
        refs.length > 0
          ? `${domain.blurb} References outside this model: ${refs.map((name) => `\`${name}\``).join(", ")}.`
          : domain.blurb,
      source,
      domain: domain.id,
    });
  }
  return diagrams;
}

/** The generated body of docs/data-model.md. */
function renderDataModel(diagrams, tables) {
  const { total, primary, authOnly } = countTables(tables);
  const parts = [
    `**${total} tables** — ${primary} defined in \`src/convex/schema.ts\` (including`,
    `\`users\`) plus ${authOnly.length} from Convex Auth's \`authTables\`.`,
    "",
    "They are split into domain models so each diagram stays readable. Every",
    "table belongs to exactly one of them; a reference that crosses domains is",
    "named under its diagram instead of drawn across it. Each diagram also",
    "carries its Mermaid source, so the text is there when a renderer is not.",
  ];

  for (const diagram of diagrams.filter((entry) => entry.domain)) {
    parts.push(
      "",
      `### ${diagram.title}`,
      "",
      diagram.caption,
      "",
      `<img src="diagrams/${diagram.id}.svg" alt="Entity relationship diagram: ${diagram.title.toLowerCase()}" />`,
      "",
      "<details>",
      "<summary>Diagram source (Mermaid)</summary>",
      "",
      "```mermaid",
      diagram.source,
      "```",
      "",
      "</details>",
    );
  }

  parts.push("", "### Indexes", "", renderIndexes(tables));
  return parts.join("\n");
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

/**
 * A browser page holding the same diagrams, each with a Download SVG button so
 * the image files in docs/diagrams/ can be re-exported after a schema change.
 */
function renderDiagramsHtml(diagrams) {
  const cards = diagrams
    .map(
      (diagram) => `  <section data-id="${diagram.id}">
    <div class="head">
      <div>
        <h2>${escapeHtml(diagram.title)}</h2>
        <p class="caption">${escapeHtml(diagram.caption)}</p>
      </div>
      <button class="download" type="button">Download SVG</button>
    </div>
    <pre class="mermaid">${escapeHtml(diagram.source)}</pre>
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
  h2 { margin: 0 0 4px; font-size: 19px; }
  .head { display: flex; gap: 16px; align-items: flex-start; justify-content: space-between; }
  .caption { margin: 0 0 16px; color: var(--muted); font-size: 14px; max-width: 90ch; }
  section { margin: 0 0 32px; padding: 24px; background: var(--card);
    border: 1px solid var(--line); border-radius: 12px; overflow-x: auto; }
  pre.mermaid { margin: 0; text-align: center; }
  button.download { flex: none; cursor: pointer; font: inherit; font-size: 13px;
    padding: 7px 12px; border-radius: 8px; border: 1px solid var(--line);
    background: var(--page); color: var(--ink); }
  button.download:hover { border-color: var(--muted); }
  p.warning { margin: 32px 0 0; color: var(--muted); font-size: 13px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em; }
</style>
</head>
<body>
<header>
  <h1>NatyaVault diagrams</h1>
  <p class="blurb">Generated from <code>docs/architecture.md</code> and <code>docs/data-model.md</code>.
  Change the schema or the docs, run <code>npm run docs:data-model</code>, then press
  <em>Download SVG</em> on a diagram and drop the file into <code>docs/diagrams/</code>.</p>
</header>
<main>
${cards}
  <p class="warning">Diagrams draw with Mermaid from the jsDelivr CDN, so this page needs an internet connection to render. The exported SVGs do not.</p>
</main>
<script>
  // Capture each source before Mermaid replaces the element with its drawing.
  window.__sources = new Map();
  document.querySelectorAll("section[data-id]").forEach(function (section) {
    var pre = section.querySelector("pre.mermaid");
    window.__sources.set(section.dataset.id, pre ? pre.textContent : "");
  });
</script>
<script type="module">
  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";

  mermaid.initialize({
    startOnLoad: true,
    maxTextSize: 400000,
    maxEdges: 2000,
    theme: window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default",
    // Real <text> labels, not <foreignObject>: the HTML kind is dropped by
    // ImageMagick, Inkscape, Visual Studio Code's image view and some SVG
    // sanitisers, which leaves a diagram of empty boxes.
    htmlLabels: false,
    // Draw at natural size and let the card scroll: an ER diagram squeezed to
    // the column width is unreadable.
    flowchart: { useMaxWidth: false, htmlLabels: false },
    er: { useMaxWidth: false, htmlLabels: false },
  });

  function hashSource(text) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  }

  document.querySelectorAll("section[data-id] button.download").forEach(function (button) {
    button.addEventListener("click", function () {
      const section = button.closest("section");
      const id = section.dataset.id;
      const drawn = section.querySelector("svg");
      if (!drawn) return;

      const clone = drawn.cloneNode(true);
      clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      const box = (clone.getAttribute("viewBox") || "").split(/[\\s,]+/).map(Number);
      if (box.length === 4 && Number.isFinite(box[2])) {
        clone.setAttribute("width", box[2]);
        clone.setAttribute("height", box[3]);
      }
      // Drop Mermaid's max-width style and paint a white background, so the
      // file reads the same on a dark page as on a light one.
      clone.removeAttribute("style");
      const background = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      background.setAttribute("width", "100%");
      background.setAttribute("height", "100%");
      background.setAttribute("fill", "#ffffff");
      clone.insertBefore(background, clone.firstChild);

      const source = window.__sources.get(id) || "";
      const text = '<?xml version="1.0" encoding="UTF-8"?>\\n<!-- source:' +
        hashSource(source) + " -->\\n" + new XMLSerializer().serializeToString(clone);
      const url = URL.createObjectURL(new Blob([text], { type: "image/svg+xml" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = id + ".svg";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    });
  });
</script>
</body>
</html>
`;
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

/** An exported SVG remembers which diagram source it came from. */
async function auditSvgs(diagrams) {
  const results = [];
  for (const diagram of diagrams) {
    const path = join(SVG_DIR, `${diagram.id}.svg`);
    let text = null;
    try {
      text = await readFile(path, "utf8");
    } catch {
      results.push({ id: diagram.id, reason: "missing" });
      continue;
    }
    const found = text.match(/<!-- source:([0-9a-f]{8}) -->/);
    if (!found) results.push({ id: diagram.id, reason: "no source stamp" });
    else if (found[1] !== hashSource(diagram.source)) {
      results.push({ id: diagram.id, reason: "out of date" });
    }
  }
  return results;
}

await mkdir(CACHE_DIR, { recursive: true });
await mkdir(SVG_DIR, { recursive: true });

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
assignDomains(tables);

const architectureSource = mermaidBlocks(await readFile(ARCHITECTURE_DOC, "utf8"))[0];
const conceptualSource = mermaidBlocks(await readFile(DATA_MODEL_DOC, "utf8"))[0];
if (!architectureSource || !conceptualSource) {
  throw new Error("Could not find the architecture or conceptual diagram source");
}

const diagrams = buildDiagramList(tables, architectureSource, conceptualSource);

const results = [
  await writeSection(
    DATA_MODEL_DOC,
    DATA_BEGIN,
    DATA_END,
    renderDataModel(diagrams, tables),
  ),
  await writeSection(
    ARCHITECTURE_DOC,
    COUNTS_BEGIN,
    COUNTS_END,
    renderCounts(tables),
  ),
  await writeGenerated(DIAGRAMS_HTML, renderDiagramsHtml(diagrams)),
];

const staleSvgs = await auditSvgs(diagrams);

for (const result of results) {
  const state = result.changed ? "updated" : result.stale ? "STALE" : "unchanged";
  console.log(`${state.padEnd(9)} ${result.path.replace(`${ROOT}/`, "")}`);
}
for (const svg of staleSvgs) {
  console.log(`SVG ${svg.reason.padEnd(14)} docs/diagrams/${svg.id}.svg`);
}
console.log(
  `${countTables(tables).total} tables in ${DOMAINS.length} domain diagrams`,
);

const failed = results.some((result) => result.stale) || staleSvgs.length > 0;
if (failed) {
  if (results.some((result) => result.stale)) {
    console.error("\nDocs are out of date — run: npm run docs:data-model");
  }
  if (staleSvgs.length > 0) {
    console.error(
      "\nSVGs need re-exporting: open docs/diagrams.html, press Download SVG, and save each file into docs/diagrams/.",
    );
  }
  if (checkOnly) process.exit(1);
}
