#!/usr/bin/env bun
import { resolve, basename } from "path";
import { readdir, readFile, stat } from "fs/promises";

const HOME = Bun.env.HOME!;
const PORT = 3117;
const QMD_JS = resolve(HOME, ".bun/install/global/node_modules/qmd/dist/qmd.js");
const VAULT_SESSIONS = resolve(HOME, "Documents/knowledge/Vault/Sessions");
const CLAUDE_PROJECTS = resolve(HOME, ".claude/projects");

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function buildResumeCommand(projectPath: string | null, uuid: string): string {
  if (projectPath) {
    return `cd ${shellQuote(projectPath)} && claude --resume ${uuid}`;
  }
  return `claude --resume ${uuid}`;
}

// --- Ported from ~/bin/cresume ---

export function extractShortId(qmdUri: string): string | null {
  const match = qmdUri.match(/([0-9a-f]{8})\.md$/);
  return match ? match[1] : null;
}

export async function resolveUuid(shortId: string): Promise<{ uuid: string; projectDir: string; jsonlPath: string } | null> {
  try {
    const projectDirs = await readdir(CLAUDE_PROJECTS);
    for (const dir of projectDirs) {
      if (dir.includes("private-tmp")) continue;
      const projectDir = resolve(CLAUDE_PROJECTS, dir);
      const files = await readdir(projectDir).catch(() => []);
      for (const file of files) {
        if (file.startsWith(shortId) && file.endsWith(".jsonl")) {
          const uuid = file.replace(/\.jsonl$/, "");
          return { uuid, projectDir, jsonlPath: resolve(projectDir, file) };
        }
      }
    }
  } catch {
    // projects dir doesn't exist or unreadable
  }
  return null;
}

export async function resolveProjectPath(projectDir: string): Promise<string | null> {
  // 1. Check sessions-index.json
  const indexPath = resolve(projectDir, "sessions-index.json");
  try {
    const indexData = await readFile(indexPath, "utf-8");
    const index = JSON.parse(indexData);
    const projectPath = index?.entries?.[0]?.projectPath;
    if (projectPath) {
      try {
        await stat(projectPath);
        return projectPath;
      } catch { /* dir doesn't exist */ }
    }
  } catch { /* no index file */ }

  // 2. Decode dir name: -Users-<user>-X → ~/X
  const dirName = basename(projectDir);
  const user = Bun.env.USER || Bun.env.LOGNAME || basename(Bun.env.HOME || "/tmp/unknown");
  const prefix = `-Users-${user}-`;
  if (dirName.startsWith(prefix)) {
    const suffix = dirName.slice(prefix.length);
    const decoded = resolve(HOME, suffix);
    try {
      await stat(decoded);
      return decoded;
    } catch { /* doesn't exist */ }
  }
  return null;
}

// --- Frontmatter Parser ---

interface Frontmatter {
  session?: string;
  date?: string;
  week?: string;
  concepts?: string[];
  summary?: string;
  [key: string]: string | string[] | undefined;
}

export function parseFrontmatter(content: string): { frontmatter: Frontmatter; body: string } {
  // Must start with ---
  if (!content.startsWith("---")) {
    return { frontmatter: {}, body: content };
  }

  // Strip leading "---\n", then split on "\n---\n" to get frontmatter blocks + body
  const stripped = content.slice(4); // remove "---\n"
  const parts = stripped.split(/\n---\n/);

  // Find the LAST block containing "session:" — handles double frontmatter
  let fmBlock = "";
  let fmEndIndex = 0;

  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].includes("session:")) {
      fmBlock = parts[i];
      fmEndIndex = i;
      break;
    }
  }

  // If no block has session:, use the first block
  if (!fmBlock) {
    fmBlock = parts[0];
    fmEndIndex = 0;
  }

  // Body is everything after the frontmatter block's closing ---
  const body = parts.slice(fmEndIndex + 1).join("\n---\n").trim();

  // Parse key-value pairs
  const fm: Frontmatter = {};
  const lines = fmBlock.split("\n");
  let currentKey = "";
  let currentValue = "";

  for (const line of lines) {
    const kvMatch = line.match(/^(\w+):\s*(.*)/);
    if (kvMatch) {
      // Save previous key
      if (currentKey) {
        fm[currentKey] = parseValue(currentValue.trim());
      }
      currentKey = kvMatch[1];
      currentValue = kvMatch[2];
    } else if (currentKey && line.startsWith("  ")) {
      // Continuation line
      currentValue += "\n" + line;
    }
  }
  // Save last key
  if (currentKey) {
    fm[currentKey] = parseValue(currentValue.trim());
  }

  return { frontmatter: fm, body };
}

function parseValue(val: string): string | string[] {
  // Array: [item1, item2] or [item1]
  if (val.startsWith("[") && val.endsWith("]")) {
    const inner = val.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map(s => s.trim().replace(/^['"]|['"]$/g, ""));
  }
  // YAML multi-line list (value is empty, continuation lines are "  - item")
  if (val === "" || val.includes("\n")) {
    const items = val.split("\n")
      .map(l => l.trim())
      .filter(l => l.startsWith("- "))
      .map(l => l.slice(2).trim().replace(/^['"]|['"]$/g, ""));
    if (items.length > 0) return items;
    if (val === "") return val; // empty value, not a list
  }
  // Strip surrounding quotes
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1);
  }
  return val;
}

// --- JSONL Conversation Preview ---

interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
}

async function readConversationPreview(jsonlPath: string, maxLines = 300): Promise<{ turns: ConversationTurn[]; gitBranch?: string; totalLines: number }> {
  const file = Bun.file(jsonlPath);
  const stream = file.stream();
  const decoder = new TextDecoder();

  const turns: ConversationTurn[] = [];
  let gitBranch: string | undefined;
  let lineCount = 0;
  let partial = "";

  for await (const chunk of stream) {
    partial += decoder.decode(chunk, { stream: true });
    const segments = partial.split("\n");
    partial = segments.pop() || "";

    for (const line of segments) {
      if (!line) continue;
      lineCount++;
      if (lineCount > maxLines) continue; // count but don't parse

      try {
        const d = JSON.parse(line);
        if (!gitBranch && d.gitBranch) gitBranch = d.gitBranch;

        if (d.type === "user" || d.type === "assistant") {
          const content = d.message?.content;
          let text = "";
          if (typeof content === "string") {
            text = content;
          } else if (Array.isArray(content)) {
            text = content
              .filter((b: any) => b.type === "text")
              .map((b: any) => b.text || "")
              .join("\n");
          }
          if (text.trim()) {
            turns.push({ role: d.type, text: text.slice(0, 2000) });
          }
        }
      } catch { /* skip malformed lines */ }
    }
  }
  // Handle final partial line
  if (partial) lineCount++;

  return { turns, gitBranch, totalLines: lineCount };
}

// --- Vault Glob ---

async function findVaultFile(shortId: string): Promise<string | null> {
  const glob = new Bun.Glob(`**/*-${shortId}.md`);
  for await (const path of glob.scan({ cwd: VAULT_SESSIONS, absolute: true })) {
    return path;
  }
  return null;
}

// --- Sessions Index Lookup ---

async function findInSessionsIndex(shortId: string): Promise<{
  sessionId: string;
  firstPrompt?: string;
  summary?: string;
  projectPath?: string;
  gitBranch?: string;
  created?: string;
  modified?: string;
  messageCount?: number;
} | null> {
  try {
    const projectDirs = await readdir(CLAUDE_PROJECTS);
    for (const dir of projectDirs) {
      const indexPath = resolve(CLAUDE_PROJECTS, dir, "sessions-index.json");
      try {
        const data = await readFile(indexPath, "utf-8");
        const index = JSON.parse(data);
        for (const entry of index.entries || []) {
          if (entry.sessionId?.startsWith(shortId)) {
            return {
              sessionId: entry.sessionId,
              firstPrompt: entry.firstPrompt,
              summary: entry.summary,
              projectPath: entry.projectPath,
              gitBranch: entry.gitBranch,
              created: entry.created,
              modified: entry.modified,
              messageCount: entry.messageCount,
            };
          }
        }
      } catch { /* skip unreadable index */ }
    }
  } catch { /* projects dir unreadable */ }
  return null;
}

// --- Search API ---

interface SearchResult {
  title: string;
  file: string;
  score: number;
  collection: string;
  date: string | null;
  shortId: string | null;
  uuid: string | null;
  projectPath: string | null;
  resumeCommand: string;
}

async function handleSearch(url: URL): Promise<Response> {
  const query = url.searchParams.get("q");
  const count = parseInt(url.searchParams.get("n") || "10", 10);

  if (!query?.trim()) {
    return Response.json({ error: "query parameter 'q' is required" }, { status: 400 });
  }

  try {
    const proc = Bun.spawn(
      ["/opt/homebrew/bin/bun", QMD_JS, "search", query, "-c", "sessions", "-c", "conversations", "-n", String(count), "--json"],
      { stdout: "pipe", stderr: "pipe", timeout: 5000 }
    );

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      return Response.json({ error: "search unavailable", results: [] }, { status: 503 });
    }

    let rawResults: Array<{ title: string; file: string; score: number; snippet?: string }>;
    try {
      rawResults = JSON.parse(stdout);
    } catch {
      return Response.json({ error: "malformed search output", results: [] }, { status: 502 });
    }

    // Enrich results with UUID resolution
    const results: SearchResult[] = await Promise.all(
      rawResults.map(async (r) => {
        const collection = r.file.replace("qmd://", "").split("/")[0];
        const dateMatch = r.file.match(/(\d{4}-\d{2}-\d{2})/);
        const date = dateMatch ? dateMatch[1] : null;
        const shortId = extractShortId(r.file);

        let uuid: string | null = null;
        let projectPath: string | null = null;
        let resumeCommand = shortId ? buildResumeCommand(null, shortId) : "";

        if (shortId) {
          const resolved = await resolveUuid(shortId);
          if (resolved) {
            uuid = resolved.uuid;
            projectPath = await resolveProjectPath(resolved.projectDir);
            resumeCommand = buildResumeCommand(projectPath, uuid);
          }
        }

        return {
          title: r.title,
          file: r.file,
          score: r.score,
          collection,
          date,
          shortId,
          uuid,
          projectPath,
          resumeCommand,
        };
      })
    );

    return Response.json({ results });
  } catch (e: any) {
    if (e?.message?.includes("timed out") || e?.message?.includes("timeout")) {
      return Response.json({ error: "search timed out", results: [] }, { status: 503 });
    }
    return Response.json({ error: "search unavailable", results: [] }, { status: 503 });
  }
}

// --- Preview API ---

interface PreviewResponse {
  shortId: string;
  previewTier: "full" | "partial" | "index" | "parse_error";
  session?: string;
  date?: string;
  week?: string;
  concepts?: string[];
  summary?: string;
  body?: string;
  firstPrompt?: string;
  projectPath?: string;
  gitBranch?: string;
  created?: string;
  modified?: string;
  messageCount?: number;
  uuid?: string;
  resumeCommand?: string;
  conversation?: ConversationTurn[];
  totalLines?: number;
}

async function handlePreview(shortId: string): Promise<Response> {
  if (!/^[0-9a-f]{8}$/.test(shortId)) {
    return Response.json({ error: "invalid shortId format" }, { status: 400 });
  }

  const result: PreviewResponse = { shortId, previewTier: "index" };

  // Resolve UUID
  const resolved = await resolveUuid(shortId);
  if (resolved) {
    result.uuid = resolved.uuid;
    const projPath = await resolveProjectPath(resolved.projectDir);
    if (projPath) {
      result.projectPath = projPath;
      result.resumeCommand = buildResumeCommand(projPath, resolved.uuid);
    } else {
      result.resumeCommand = buildResumeCommand(null, resolved.uuid);
    }
  } else {
    result.resumeCommand = buildResumeCommand(null, shortId);
  }

  // Try Vault file
  const vaultFile = await findVaultFile(shortId);
  if (vaultFile) {
    try {
      const content = await readFile(vaultFile, "utf-8");
      const { frontmatter, body } = parseFrontmatter(content);

      result.body = body;
      if (frontmatter.session) result.session = frontmatter.session as string;
      if (frontmatter.date) result.date = frontmatter.date as string;
      if (frontmatter.week) result.week = frontmatter.week as string;
      if (frontmatter.concepts) result.concepts = frontmatter.concepts as string[];
      if (frontmatter.summary) result.summary = frontmatter.summary as string;

      if (result.summary && result.session) {
        result.previewTier = "full";
      } else {
        result.previewTier = "partial";
        // Supplement from sessions-index
        const indexData = await findInSessionsIndex(shortId);
        if (indexData) {
          if (!result.summary && indexData.summary) result.summary = indexData.summary;
          if (indexData.firstPrompt) result.firstPrompt = indexData.firstPrompt;
          if (indexData.gitBranch) result.gitBranch = indexData.gitBranch;
          if (indexData.created) result.created = indexData.created;
          if (indexData.modified) result.modified = indexData.modified;
          if (indexData.messageCount) result.messageCount = indexData.messageCount;
        }
      }
    } catch {
      result.previewTier = "parse_error";
      result.body = "Failed to read Vault file";
    }
    return Response.json(result);
  }

  // Tier 3: sessions-index only
  const indexData = await findInSessionsIndex(shortId);
  if (indexData) {
    result.previewTier = "index";
    result.summary = indexData.summary;
    result.firstPrompt = indexData.firstPrompt;
    result.projectPath = indexData.projectPath || result.projectPath;
    result.gitBranch = indexData.gitBranch;
    result.created = indexData.created;
    result.modified = indexData.modified;
    result.messageCount = indexData.messageCount;
    if (indexData.sessionId) {
      result.uuid = indexData.sessionId;
      if (result.projectPath) {
        result.resumeCommand = buildResumeCommand(result.projectPath, indexData.sessionId);
      } else {
        result.resumeCommand = buildResumeCommand(null, indexData.sessionId);
      }
    }
    // Read conversation from .jsonl if available
    if (resolved?.jsonlPath) {
      try {
        const conv = await readConversationPreview(resolved.jsonlPath);
        result.conversation = conv.turns;
        result.totalLines = conv.totalLines;
        if (!result.gitBranch && conv.gitBranch) result.gitBranch = conv.gitBranch;
      } catch { /* .jsonl unreadable */ }
    }
    return Response.json(result);
  }

  // Tier 4: session file exists on disk but not in sessions-index.json
  // resolveUuid already ran at top — if result.uuid is set, the session exists
  if (result.uuid && resolved?.jsonlPath) {
    result.previewTier = "index";
    try {
      const conv = await readConversationPreview(resolved.jsonlPath);
      result.conversation = conv.turns;
      result.totalLines = conv.totalLines;
      if (conv.gitBranch) result.gitBranch = conv.gitBranch;
      if (conv.turns.length > 0) {
        result.firstPrompt = conv.turns[0].text.slice(0, 200);
      }
    } catch { /* .jsonl unreadable */ }
    return Response.json(result);
  } else if (result.uuid) {
    result.previewTier = "index";
    return Response.json(result);
  }

  return Response.json({ error: "session not found" }, { status: 404 });
}

// --- Static File Serving ---

const INDEX_HTML_PATH = resolve(import.meta.dir, "index.html");

// --- Server ---

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/api/search" && req.method === "GET") {
      return handleSearch(url);
    }

    if (url.pathname.startsWith("/api/preview/") && req.method === "GET") {
      const shortId = url.pathname.slice("/api/preview/".length);
      if (!/^[0-9a-f]{8}$/.test(shortId)) {
        return Response.json({ error: "invalid shortId" }, { status: 400 });
      }
      return handlePreview(shortId);
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const file = Bun.file(INDEX_HTML_PATH);
      return new Response(file, { headers: { "Content-Type": "text/html" } });
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },
  error(err) {
    return Response.json({ error: "internal server error" }, { status: 500 });
  },
});

console.log(`cresume-web running on http://localhost:${PORT}`);

export { server };
