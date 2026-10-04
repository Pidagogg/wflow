/**
 * jsonAssist — what makes the workflow JSON editor understand workflows.
 *
 * CodeMirror knows JSON; this module knows W flow. It maps between positions
 * in the text and JSON paths ("nodes[2].data.config.url"), so the shared
 * validator's findings are underlined on the exact line (C2), and autocomplete
 * can offer what fits where the cursor is (C3): node types, a node's setting
 * names and allowed values, node ids and branch handles on edges, and the
 * {{fields}} the steps before a node really output.
 *
 * Mode "node" edits a single node object; its paths are reported as if it
 * were nodes[0] of a one-node workflow, so the same validator and the same
 * completions apply.
 */
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import type { Diagnostic } from "@codemirror/lint";
import type { EditorView } from "@codemirror/view";
import type { Catalog, NodeDef } from "./types";
import { validateWorkflow, fieldsBefore } from "../shared/workflow-validate.js";
import { outputHandlesFor } from "../shared/node-outputs.js";

export type JsonMode = "workflow" | "node";
type Seg = string | number;
type AnyObj = Record<string, unknown>;

// ---- paths ----
const unquote = (text: string) => {
  try {
    return String(JSON.parse(text));
  } catch {
    return text.replace(/^"|"$/g, "");
  }
};

const isValue = (n: SyntaxNode) => !["[", "]", "{", "}", ",", ":", "⚠", "PropertyName"].includes(n.name);

/** "nodes[2].data.config.url" for ["nodes", 2, "data", "config", "url"]. */
export function pathString(segs: Seg[]): string {
  return segs.reduce<string>((acc, s) => (typeof s === "number" ? `${acc}[${s}]` : acc ? `${acc}.${s}` : s), "");
}

/** Every path in the document → the text range of its value (and its key). */
function indexPaths(state: EditorState): Map<string, { from: number; to: number }> {
  const out = new Map<string, { from: number; to: number }>();
  const doc = state.doc;
  const walk = (node: SyntaxNode, segs: Seg[]) => {
    if (node.name === "Object") {
      for (let p = node.firstChild; p; p = p.nextSibling) {
        if (p.name !== "Property") continue;
        const key = p.getChild("PropertyName");
        if (!key) continue;
        const name = unquote(doc.sliceString(key.from, key.to));
        const val = key.nextSibling?.nextSibling; // PropertyName ":" value
        const here = [...segs, name];
        out.set(pathString(here), { from: key.from, to: val ? val.to : key.to });
        if (val) walk(val, here);
      }
    } else if (node.name === "Array") {
      let i = 0;
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (!isValue(c)) continue;
        const here = [...segs, i];
        out.set(pathString(here), { from: c.from, to: c.to });
        walk(c, here);
        i += 1;
      }
    }
  };
  const top = syntaxTree(state).topNode.firstChild;
  if (top) walk(top, []);
  return out;
}

/**
 * The path of the object / array the cursor is in, read straight from the text
 * up to `pos`. Unlike the syntax tree this keeps working while the text is
 * half-typed (an open quote, a missing colon), which is exactly when
 * completions are asked for.
 */
export function containerPathAt(text: string, pos: number): Seg[] {
  type Frame = { kind: "obj" | "arr"; key: string | null; index: number; seg: Seg | null };
  const stack: Frame[] = [];
  let lastString: string | null = null;
  for (let i = 0; i < pos; i++) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      let out = "";
      while (j < pos && text[j] !== '"') {
        if (text[j] === "\\") j += 1;
        out += text[j] ?? "";
        j += 1;
      }
      lastString = out;
      i = j;
      continue;
    }
    const top = stack[stack.length - 1];
    if (ch === "{" || ch === "[") {
      const seg: Seg | null = top ? (top.kind === "arr" ? top.index : top.key) : null;
      stack.push({ kind: ch === "{" ? "obj" : "arr", key: null, index: 0, seg });
    } else if (ch === "}" || ch === "]") {
      stack.pop();
    } else if (ch === ":" && top?.kind === "obj") {
      top.key = lastString;
    } else if (ch === ",") {
      if (top?.kind === "arr") top.index += 1;
      else if (top) top.key = null;
    }
  }
  return stack.slice(1).map((f) => f.seg).filter((s): s is Seg => s !== null);
}

// ---- the workflow behind the text ----
// While the user types, the text is often briefly invalid. Completions then
// fall back to the last version that parsed (one per editor mode), so
// suggestions keep working. The linter and the editor's first render feed it.
const lastGood: Partial<Record<JsonMode, { text: string; value: unknown }>> = {};
export function rememberParsed(mode: JsonMode, text: string): unknown {
  if (lastGood[mode]?.text === text) return lastGood[mode]!.value;
  try {
    const value = JSON.parse(text);
    lastGood[mode] = { text, value };
    return value;
  } catch {
    return lastGood[mode]?.value ?? null;
  }
}

/** The document as a workflow (a node document is wrapped as nodes[0]). */
function asWorkflow(value: unknown, mode: JsonMode, context?: { nodes: AnyObj[]; edges: AnyObj[] }): AnyObj | null {
  if (!value || typeof value !== "object") return null;
  if (mode === "workflow") return value as AnyObj;
  // A single node is checked inside the real graph around it (its neighbours
  // decide which {{fields}} it can use), with itself swapped in.
  const node = value as AnyObj;
  const others = (context?.nodes || []).filter((n) => n.id !== node.id);
  return { nodes: [node, ...others], edges: context?.edges || [] };
}
const nodePrefix = (mode: JsonMode): Seg[] => (mode === "node" ? ["nodes", 0] : []);

// ---- lint (C2) ----
export function workflowLinter(getCatalog: () => Catalog, mode: JsonMode, getContext?: () => { nodes: AnyObj[]; edges: AnyObj[] }) {
  return (view: EditorView): Diagnostic[] => {
    const state = view.state;
    let value: unknown;
    try {
      value = JSON.parse(state.doc.toString());
    } catch {
      return []; // the JSON syntax linter reports that one
    }
    rememberParsed(mode, state.doc.toString());
    const wf = asWorkflow(value, mode, getContext?.());
    if (!wf) return [];
    const { errors, warnings } = validateWorkflow(wf, { nodes: getCatalog().nodes as unknown as Record<string, unknown> });
    const paths = indexPaths(state);
    const prefix = pathString(nodePrefix(mode));
    const out: Diagnostic[] = [];
    for (const issue of [...errors, ...warnings]) {
      let p = issue.path || "";
      if (mode === "node") {
        // Only this node's own findings; the neighbours are only context.
        if (!(p === prefix || p.startsWith(`${prefix}.`) || p.startsWith(`${prefix}[`))) continue;
        p = p.slice(prefix.length).replace(/^\./, "");
      }
      // Walk up until a path that exists in the text (e.g. a missing key → its object).
      let range = paths.get(p);
      while (!range && p) {
        p = p.replace(/(\.[^.[\]]+|\[\d+\])$/, "");
        range = paths.get(p);
      }
      const from = range ? range.from : 0;
      const to = range ? Math.min(range.to, from + 400) : Math.min(state.doc.length, 1);
      out.push({ from, to, severity: issue.severity, message: issue.message, source: "W flow" });
    }
    return out;
  };
}

// ---- autocomplete (C3) ----
const TOP_KEYS = ["name", "description", "nodes", "edges"];
const NODE_KEYS = ["id", "type", "position", "data"];
const DATA_KEYS = ["label", "config"];
const EDGE_KEYS = ["id", "source", "target", "sourceHandle", "targetHandle"];

function optionValues(f: { options?: unknown }): string[] {
  return Array.isArray(f.options) ? f.options.map((o: unknown) => (typeof o === "string" ? o : String((o as { value?: unknown })?.value ?? ""))).filter(Boolean) : [];
}

// The editor auto-closes quotes, so the cursor usually sits right before a
// closing `"`. The completion replaces through it and writes `text` itself,
// so the result is the same with or without the auto-inserted quote.
function applyThroughQuote(text: string) {
  return (view: EditorView, _c: Completion, from: number, to: number) => {
    const end = view.state.sliceDoc(to, to + 1) === '"' ? to + 1 : to;
    view.dispatch({ changes: { from, to: end, insert: text }, selection: { anchor: from + text.length }, userEvent: "input.complete" });
  };
}

export function workflowCompletions(getCatalog: () => Catalog, mode: JsonMode, getContext?: () => { nodes: AnyObj[]; edges: AnyObj[] }) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const { state, pos } = ctx;
    const line = state.doc.lineAt(pos);
    const before = line.text.slice(0, pos - line.from);
    const catalog = getCatalog();
    const wf = asWorkflow(rememberParsed(mode, state.doc.toString()), mode, getContext?.());
    const nodesArr = (Array.isArray(wf?.nodes) ? wf!.nodes : []) as AnyObj[];

    // Where in the document is the cursor? The path of the object around it.
    const objPath = [...nodePrefix(mode), ...containerPathAt(state.doc.toString(), pos)];

    // 1. {{placeholder}} inside a string value.
    const ph = before.match(/\{\{\s*([\w.$]*)$/);
    if (ph) {
      const nodeIdx = objPath[0] === "nodes" && typeof objPath[1] === "number" ? objPath[1] : -1;
      const node = nodeIdx >= 0 ? nodesArr[nodeIdx] : undefined;
      const known = node && wf ? fieldsBefore(wf, String(node.id), { nodes: catalog.nodes as unknown as Record<string, unknown> }) : { fields: [], open: true };
      const options: Completion[] = [
        ...known.fields.map((f) => ({ label: f, type: "property", detail: "from an earlier step", boost: 2 })),
        { label: "json", type: "keyword", detail: "the whole item" },
        { label: "$env", type: "keyword", detail: '"live" or "test"' },
        { label: "$vars.", type: "keyword", detail: "a Variable" },
      ];
      return { from: pos - ph[1].length, options, validFor: /^[\w.$]*$/ };
    }

    // 2. A property name: `"par|` right after `{` or `,`.
    const key = before.match(/(^|[{,])\s*"([\w$-]*)$/);
    if (key) {
      const from = pos - key[2].length;
      const at = pathString(objPath);
      let names: Completion[] = [];
      if (at === "") names = TOP_KEYS.map((k) => ({ label: k, type: "property" }));
      else if (/^nodes\[\d+\]$/.test(at)) names = NODE_KEYS.map((k) => ({ label: k, type: "property" }));
      else if (/^nodes\[\d+\]\.data$/.test(at)) names = DATA_KEYS.map((k) => ({ label: k, type: "property" }));
      else if (/^edges\[\d+\]$/.test(at)) names = EDGE_KEYS.map((k) => ({ label: k, type: "property" }));
      else if (/^nodes\[\d+\]\.data\.config$/.test(at)) {
        const def: NodeDef | undefined = catalog.nodes[String(nodesArr[Number(objPath[1])]?.type || "")];
        names = (def?.fields || [])
          .filter((f) => f.type !== "note")
          .map((f) => ({ label: f.key, type: "property", detail: f.type, info: [f.label, f.help].filter(Boolean).join(" — ") || undefined }));
      } else if (/^nodes\[\d+\]\.position$/.test(at)) names = ["x", "y"].map((k) => ({ label: k, type: "property" }));
      return names.length ? { from, options: names.map((c) => ({ ...c, apply: applyThroughQuote(`${c.label}": `) })), validFor: /^[\w$-]*$/ } : null;
    }

    // 3. A string value: `"key": "val|`.
    const val = before.match(/"([\w$-]+)"\s*:\s*"([^"]*)$/);
    if (val) {
      const [, prop, typed] = val;
      const from = pos - typed.length;
      const at = pathString(objPath);
      let options: Completion[] = [];
      if (/^nodes\[\d+\]$/.test(at) && prop === "type") {
        options = Object.values(catalog.nodes).map((d) => ({ label: d.type, type: "class", detail: d.name, info: d.description }));
      } else if (/^edges\[\d+\]$/.test(at) && (prop === "source" || prop === "target")) {
        options = nodesArr.map((n) => ({ label: String(n.id), type: "variable", detail: String((n.data as AnyObj | undefined)?.label || n.type || "") }));
      } else if (/^edges\[\d+\]$/.test(at) && prop === "sourceHandle") {
        const edge = (Array.isArray(wf?.edges) ? (wf!.edges as AnyObj[]) : [])[Number(objPath[1])];
        const src = nodesArr.find((n) => String(n.id) === String(edge?.source));
        const handles = src ? outputHandlesFor(src as never, catalog.nodes[String(src.type)]) : ["out"];
        options = handles.map((h) => ({ label: h, type: "enum" }));
      } else if (/^edges\[\d+\]$/.test(at) && prop === "targetHandle") {
        options = [{ label: "in", type: "enum" }];
      } else if (/^nodes\[\d+\]\.data\.config$/.test(at)) {
        const def: NodeDef | undefined = catalog.nodes[String(nodesArr[Number(objPath[1])]?.type || "")];
        const field = def?.fields.find((f) => f.key === prop);
        if (field) options = optionValues(field).map((v) => ({ label: v, type: "enum" }));
      }
      return options.length ? { from, options: options.map((c) => ({ ...c, apply: applyThroughQuote(`${c.label}"`) })), validFor: /^[^"]*$/ } : null;
    }
    return null;
  };
}

/** Text position of a JSON path (for "jump to node" / error lists). */
export function positionOf(state: EditorState, path: string): number | null {
  return indexPaths(state).get(path)?.from ?? null;
}
