import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkHtml from "remark-html";
import { visit } from "unist-util-visit";
import type { Root, Table, TableRow, TableCell, List, ListItem } from "mdast";

// ── Public types ────────────────────────────────────────────────────

/** A single parsed markdown table: header row + data rows. */
export interface ParsedTable {
  /** Column headers extracted from the first row. */
  headers: string[];
  /** Each data row as a string array matching the headers. */
  rows: string[][];
}

/** A single parsed markdown list. */
export interface ParsedList {
  /** Whether the list is ordered (numbered). */
  ordered: boolean;
  /** Plain-text content of each list item. */
  items: string[];
}

/** Return value of `parseMarkdown`. */
export interface ParsedMarkdown {
  /** The full markdown converted to an HTML string. */
  html: string;
  /** All tables discovered in the document, in document order. */
  tables: ParsedTable[];
  /** All lists discovered in the document, in document order. */
  lists: ParsedList[];
  /** True when AST parsing failed and only raw html (or empty) is returned. */
  fallbackUsed: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Recursively extract plain text from any mdast node. */
function nodeToText(node: unknown): string {
  const n = node as { type: string; value?: string; children?: unknown[] };
  if (n.type === "text" || n.type === "inlineCode") return n.value ?? "";
  if (Array.isArray(n.children)) return n.children.map(nodeToText).join("");
  return "";
}

/** Extract a flat string array from table cells in a single row. */
function rowCells(row: TableRow): string[] {
  return (row.children as TableCell[]).map((cell) =>
    nodeToText(cell).trim()
  );
}

// ── Core parser ─────────────────────────────────────────────────────

/**
 * Parse a markdown string into structured data (tables, lists) plus an
 * HTML rendering of the full document.
 *
 * Uses remark + remark-gfm for GitHub-Flavored Markdown (pipe tables,
 * task lists, strikethrough, etc.) and remark-html for the HTML output.
 */
export async function parseMarkdown(
  markdownContent: string
): Promise<ParsedMarkdown> {
  const tables: ParsedTable[] = [];
  const lists: ParsedList[] = [];

  try {
    const processor = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(() => (tree: Root) => {
        visit(tree, "table", (node: Table) => {
          const [headerRow, ...dataRows] = node.children as TableRow[];
          if (!headerRow) return;

          tables.push({
            headers: rowCells(headerRow),
            rows: dataRows.map(rowCells),
          });
        });

        visit(tree, "list", (node: List) => {
          lists.push({
            ordered: node.ordered ?? false,
            items: (node.children as ListItem[]).map((li) =>
              nodeToText(li).trim()
            ),
          });
        });
      })
      .use(remarkHtml, { sanitize: true });

    const vfile = await processor.process(markdownContent);

    return {
      html: String(vfile),
      tables,
      lists,
      fallbackUsed: false,
    };
  } catch {
    // AST pipeline failed — return raw content as-is so callers degrade
    // gracefully instead of crashing.
    return {
      html: markdownContent,
      tables: [],
      lists: [],
      fallbackUsed: true,
    };
  }
}
