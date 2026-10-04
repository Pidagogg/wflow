/**
 * JsonCodeEditor — the workflow / node JSON editor (CodeMirror 6).
 *
 * Line numbers, folding, bracket matching, search & replace (Ctrl+F / Ctrl+H),
 * undo history and multiple cursors come from CodeMirror's basic setup. On top
 * of that (src/jsonAssist.ts): the shared workflow validator underlines
 * problems on their line as you type, and autocomplete (Ctrl+Space, or just
 * typing) offers node types, settings, allowed values, node ids, branch
 * handles and the {{fields}} earlier steps output.
 *
 * Uncontrolled on purpose: the parent passes the initial text and hears every
 * change; re-rendering never resets the cursor or the undo history.
 */
import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import { autocompletion } from "@codemirror/autocomplete";
import { indentWithTab } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Catalog } from "../types";
import { rememberParsed, workflowCompletions, workflowLinter, type JsonMode } from "../jsonAssist";

interface Props {
  initialValue: string;
  catalog: Catalog;
  mode: JsonMode;
  onChange: (text: string) => void;
  /** counts after each check — the parent can disable Apply on errors */
  onIssues?: (counts: { errors: number; warnings: number }) => void;
  /** the rest of the graph, for a single node's {{field}} suggestions and checks */
  context?: () => { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };
  /** Ctrl/Cmd+Enter */
  onSubmit?: () => void;
}

// The app's dark palette (src/styles.css :root) — the editor should look like
// part of the page, not a pasted-in widget.
const theme = EditorView.theme(
  {
    "&": { height: "100%", backgroundColor: "#0a0f1c", color: "#cfe3ff", fontSize: "12px" },
    ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.55" },
    ".cm-content": { caretColor: "var(--ink)" },
    ".cm-gutters": { backgroundColor: "#0a0f1c", color: "var(--ink-faint)", border: "none", borderRight: "1px solid var(--line)" },
    ".cm-activeLine": { backgroundColor: "rgba(74,125,255,0.06)" },
    ".cm-activeLineGutter": { backgroundColor: "rgba(74,125,255,0.10)", color: "var(--ink-dim)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "rgba(74,125,255,0.30) !important" },
    ".cm-cursor": { borderLeftColor: "var(--ink)" },
    ".cm-matchingBracket": { backgroundColor: "rgba(74,125,255,0.25)", outline: "none" },
    ".cm-foldPlaceholder": { backgroundColor: "var(--bg-elev2)", border: "none", color: "var(--ink-dim)" },
    ".cm-tooltip": { backgroundColor: "var(--bg-elev)", border: "1px solid var(--line-strong)", color: "var(--ink)" },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--accent-soft)", color: "var(--ink)" },
    ".cm-completionDetail": { color: "var(--ink-faint)", fontStyle: "normal", marginLeft: "8px" },
    ".cm-completionInfo": { maxWidth: "320px", whiteSpace: "pre-wrap" },
    ".cm-panels": { backgroundColor: "var(--bg-elev)", color: "var(--ink)" },
    ".cm-panels input, .cm-panels button": { color: "var(--ink)" },
    ".cm-searchMatch": { backgroundColor: "rgba(217,169,78,0.28)" },
    ".cm-diagnostic-error": { borderLeftColor: "var(--red)" },
    ".cm-diagnostic-warning": { borderLeftColor: "var(--amber)" },
  },
  { dark: true }
);

// JSON token colours in the same restrained palette.
const tokens = syntaxHighlighting(
  HighlightStyle.define([
    { tag: t.propertyName, color: "#8fb4ff" },
    { tag: t.string, color: "#9fe0bd" },
    { tag: t.number, color: "#f2c27b" },
    { tag: [t.bool, t.null], color: "#d9a0ff" },
    { tag: [t.separator, t.brace, t.squareBracket, t.punctuation], color: "#6a7897" },
  ])
);

export default function JsonCodeEditor({ initialValue, catalog, mode, onChange, onIssues, context, onSubmit }: Props) {
  const host = useRef<HTMLDivElement>(null);
  // Latest props for the long-lived editor callbacks.
  const live = useRef({ catalog, onChange, onIssues, context, onSubmit });
  live.current = { catalog, onChange, onIssues, context, onSubmit };

  useEffect(() => {
    if (!host.current) return;
    rememberParsed(mode, initialValue);
    const syntax = jsonParseLinter();
    const checks = workflowLinter(() => live.current.catalog, mode, () => live.current.context?.() || { nodes: [], edges: [] });
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initialValue,
        extensions: [
          basicSetup,
          json(),
          theme,
          tokens,
          keymap.of([
            indentWithTab,
            {
              key: "Mod-Enter",
              run: () => {
                live.current.onSubmit?.();
                return true;
              },
            },
          ]),
          lintGutter(),
          linter(
            (v) => {
              const syntaxIssues = syntax(v);
              const all: Diagnostic[] = syntaxIssues.length ? syntaxIssues : checks(v);
              live.current.onIssues?.({
                errors: all.filter((d) => d.severity === "error").length,
                warnings: all.filter((d) => d.severity === "warning").length,
              });
              return all;
            },
            { delay: 350 }
          ),
          autocompletion({
            override: [workflowCompletions(() => live.current.catalog, mode, () => live.current.context?.() || { nodes: [], edges: [] })],
            activateOnTyping: true,
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) live.current.onChange(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.focus();
    return () => view.destroy();
    // The editor is created once per mount; later text comes from the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Escape belongs to the editor (close search, suggestions, the lint panel):
  // it must not bubble up and close the window with unapplied edits in it.
  return <div className="json-code-editor" ref={host} onKeyDown={(e) => e.key === "Escape" && e.stopPropagation()} />;
}
