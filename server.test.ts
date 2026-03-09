import { describe, test, expect } from "bun:test";
import { extractShortId, parseFrontmatter } from "./server";

describe("extractShortId", () => {
  test("extracts 8-hex suffix from qmd URI", () => {
    expect(extractShortId("qmd://sessions/2026-W10/2026-03-04-0132-tooling-scout-716d52ef.md")).toBe("716d52ef");
  });

  test("extracts from complex filename", () => {
    expect(extractShortId("qmd://conversations/2026-W09/2026-02-28-hook-lifecycle-0ad0baae.md")).toBe("0ad0baae");
  });

  test("returns null for no hex suffix", () => {
    expect(extractShortId("qmd://sessions/no-hex.md")).toBeNull();
  });

  test("returns null for short hex", () => {
    expect(extractShortId("qmd://sessions/abc.md")).toBeNull();
  });

  test("returns null for non-md file", () => {
    expect(extractShortId("qmd://sessions/file-716d52ef.txt")).toBeNull();
  });
});

describe("parseFrontmatter", () => {
  test("parses normal single-block frontmatter", () => {
    const content = `---
session: 716d52ef
date: "2026-03-04"
week: "2026-W10"
concepts: [tooling-scout, linear-mcp, architecture]
summary: Tooling scout evaluated Linear MCP server architecture
---

# Session Content

Some body text here.`;

    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter.session).toBe("716d52ef");
    expect(frontmatter.date).toBe("2026-03-04");
    expect(frontmatter.week).toBe("2026-W10");
    expect(frontmatter.concepts).toEqual(["tooling-scout", "linear-mcp", "architecture"]);
    expect(frontmatter.summary).toBe("Tooling scout evaluated Linear MCP server architecture");
    expect(body).toContain("# Session Content");
  });

  test("handles double frontmatter (concepts-only first block)", () => {
    const content = `---
concepts: []
---
session: 0ad0baae
date: "2026-03-02"
summary: Hook lifecycle analysis session
---

Body text`;

    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter.session).toBe("0ad0baae");
    expect(frontmatter.date).toBe("2026-03-02");
    expect(frontmatter.summary).toBe("Hook lifecycle analysis session");
    expect(body).toContain("Body text");
  });

  test("handles partial frontmatter (missing summary)", () => {
    const content = `---
session: abcd1234
date: "2026-03-01"
concepts: [testing]
---

Some content without a summary field.`;

    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter.session).toBe("abcd1234");
    expect(frontmatter.date).toBe("2026-03-01");
    expect(frontmatter.summary).toBeUndefined();
    expect(body).toContain("Some content");
  });

  test("handles summary with colons", () => {
    const content = `---
session: 12345678
summary: This is a summary: with a colon and more: text
---

Body`;

    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter.summary).toBe("This is a summary: with a colon and more: text");
  });

  test("handles empty concepts array", () => {
    const content = `---
session: 99887766
concepts: []
---

Body`;

    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter.concepts).toEqual([]);
  });

  test("handles no frontmatter", () => {
    const content = "Just plain text with no frontmatter.";
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter).toEqual({});
    expect(body).toBe(content);
  });

  test("handles quoted values", () => {
    const content = `---
session: aabbccdd
date: "2026-01-15"
week: '2026-W03'
---

Body`;

    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter.date).toBe("2026-01-15");
    expect(frontmatter.week).toBe("2026-W03");
  });
});
