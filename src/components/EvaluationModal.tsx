import { useMemo, useState } from "react";
import { FlaskConical, Play, Plus, Trash2, X } from "lucide-react";
import { api } from "../api";
import type { ExecResult, FlowNode, TestResult, WaitingRun, WorkflowTest } from "../types";
import Select from "./Select";

interface Props {
  workflowId: string;
  tests: WorkflowTest[];
  nodes: FlowNode[];
  onChange: (tests: WorkflowTest[]) => void;
  /** show a finished run in the editor's Log console */
  onShowResult?: (result: ExecResult) => void;
  onClose: () => void;
}

function isWaitingRun(res: ExecResult | WaitingRun): res is WaitingRun {
  return (res as WaitingRun).waiting === true;
}

/** Pull the output items an assertion should look at. */
function outputsFor(res: ExecResult, nodeId?: string): { items: unknown[]; label: string } {
  if (nodeId) {
    const entry = [...res.log].reverse().find((l) => l.nodeId === nodeId);
    if (!entry) return { items: [], label: `node ${nodeId}` };
    return { items: entry.outputItems, label: entry.nodeName || nodeId };
  }
  const items = res.log.flatMap((l) => l.outputItems);
  return { items, label: "all nodes" };
}

function evaluate(res: ExecResult, test: WorkflowTest): { pass: boolean; detail: string } {
  const wantSuccess = test.expect.success !== false;
  const expect = test.expect;
  const hasAssertion = !!expect.nodeId || expect.contains !== undefined || expect.equals !== undefined;
  if (res.success !== wantSuccess) {
    return {
      pass: false,
      detail: wantSuccess
        ? `expected success but the run reported errors (${res.errorCount ?? 0})`
        : "expected the run to fail but it succeeded",
    };
  }
  if (!hasAssertion) return { pass: true, detail: wantSuccess ? "run succeeded" : "run failed as expected" };

  const { items, label } = outputsFor(res, expect.nodeId);
  const text = JSON.stringify(items);
  if (expect.contains !== undefined && expect.contains !== "") {
    if (!text.includes(expect.contains)) {
      return { pass: false, detail: `${label} output does not contain “${expect.contains}”` };
    }
  }
  if (expect.equals !== undefined && expect.equals !== "") {
    const last = items[items.length - 1];
    if (JSON.stringify(last ?? null) !== expect.equals.trim()) {
      return { pass: false, detail: `${label} last output is ${JSON.stringify(last ?? null)}, expected ${expect.equals.trim()}` };
    }
  }
  return { pass: true, detail: wantSuccess ? "assertions passed" : "run failed as expected" };
}

export default function EvaluationModal({ workflowId, tests, nodes, onChange, onShowResult, onClose }: Props) {
  const [results, setResults] = useState<TestResult[]>([]);
  const [running, setRunning] = useState(false);
  const [activeTest, setActiveTest] = useState<string | null>(null);

  const byId = useMemo(() => new Map(results.map((r) => [r.testId, r])), [results]);
  const passCount = results.filter((r) => r.pass).length;

  const patchTest = (id: string, patch: Partial<WorkflowTest>) =>
    onChange(tests.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  const patchExpect = (id: string, patch: Partial<WorkflowTest["expect"]>) =>
    onChange(tests.map((t) => (t.id === id ? { ...t, expect: { ...t.expect, ...patch } } : t)));

  const addTest = () => {
    const id = `t-${crypto.randomUUID().slice(0, 8)}`;
    onChange([
      ...tests,
      { id, name: `Test ${tests.length + 1}`, payload: {}, expect: { success: true, contains: "" } },
    ]);
  };

  const removeTest = (id: string) => {
    onChange(tests.filter((t) => t.id !== id));
    setResults((rs) => rs.filter((r) => r.testId !== id));
  };

  /** Run one test and record the outcome. */
  const runOne = async (test: WorkflowTest): Promise<TestResult> => {
    const started = Date.now();
    try {
      const res = await api.workflows.run(workflowId, { payload: test.payload ?? {} });
      if (isWaitingRun(res)) {
        return { testId: test.id, name: test.name, pass: false, durationMs: Date.now() - started, detail: "the run is waiting for its trigger — provide a payload that fires it" };
      }
      const { pass, detail } = evaluate(res, test);
      return { testId: test.id, name: test.name, pass, durationMs: res.durationMs ?? Date.now() - started, detail, result: res };
    } catch (err) {
      return { testId: test.id, name: test.name, pass: false, durationMs: Date.now() - started, detail: String((err as Error).message || err) };
    }
  };

  const runAll = async () => {
    if (running || tests.length === 0) return;
    setRunning(true);
    setResults([]);
    const out: TestResult[] = [];
    for (const test of tests) {
      setActiveTest(test.id);
      const r = await runOne(test);
      out.push(r);
      setResults([...out]);
    }
    setActiveTest(null);
    setRunning(false);
  };

  const runSingle = async (test: WorkflowTest) => {
    if (running) return;
    setRunning(true);
    setActiveTest(test.id);
    const r = await runOne(test);
    setResults((rs) => [...rs.filter((x) => x.testId !== test.id), r]);
    setActiveTest(null);
    setRunning(false);
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="modal modal-eval" role="dialog" aria-modal="true" aria-label="Evaluation" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="modal-title">
              <FlaskConical size={13} /> EVALUATION
            </div>
            <div className="modal-sub">
              Automated tests for this workflow. Each test runs it with a trigger payload and checks the outcome — use it to
              catch regressions after editing nodes.
            </div>
          </div>
          <button className="modal-x" onClick={onClose} title="Close">
            <X size={14} />
          </button>
        </div>

        <div className="eval-toolbar">
          <button className="btn btn-sm" onClick={addTest} disabled={running}>
            <Plus size={12} /> ADD TEST
          </button>
          <button className="btn btn-sm btn-primary" onClick={runAll} disabled={running || tests.length === 0}>
            <Play size={12} /> {running ? "Running…" : "Run all tests"}
          </button>
          {results.length > 0 && (
            <span className={`eval-summary ${passCount === results.length ? "ok" : "err"}`}>
              {passCount}/{results.length} PASSED
            </span>
          )}
        </div>

        <div className="eval-body">
          {tests.length === 0 && (
            <div className="insp-hint-box">
              No tests yet. Add one, paste a trigger payload (JSON), and optionally assert on a node's output.
            </div>
          )}

          {tests.map((test) => {
            const r = byId.get(test.id);
            const isActive = activeTest === test.id;
            return (
              <div key={test.id} className={`eval-card ${r ? (r.pass ? "pass" : "fail") : ""}`}>
                <div className="eval-card-head">
                  <input
                    className="eval-name"
                    value={test.name}
                    onChange={(e) => patchTest(test.id, { name: e.target.value })}
                    placeholder="Test name"
                  />
                  {r && <span className={`eval-badge ${r.pass ? "ok" : "err"}`}>{r.pass ? "PASS" : "FAIL"}</span>}
                  {isActive && <span className="spinner" />}
                  <button className="btn btn-sm" onClick={() => runSingle(test)} disabled={running} title="Run this test">
                    <Play size={11} />
                  </button>
                  <button className="btn btn-sm btn-danger" onClick={() => removeTest(test.id)} disabled={running} title="Delete this test">
                    <Trash2 size={11} />
                  </button>
                </div>

                <label className="eval-label">Trigger payload (JSON)</label>
                <textarea
                  className="eval-json"
                  spellCheck={false}
                  value={typeof test.payload === "string" ? test.payload : JSON.stringify(test.payload ?? {}, null, 2)}
                  onChange={(e) => {
                    try {
                      patchTest(test.id, { payload: JSON.parse(e.target.value) });
                    } catch {
                      // keep the raw text while it is invalid
                      patchTest(test.id, { payload: e.target.value });
                    }
                  }}
                />

                <div className="eval-expect">
                  <label className="eval-check">
                    <input
                      type="checkbox"
                      checked={test.expect.success !== false}
                      onChange={(e) => patchExpect(test.id, { success: e.target.checked })}
                    />
                    must succeed
                  </label>
                  <Select
                    className="eval-node"
                    value={test.expect.nodeId || ""}
                    onChange={(e) => patchExpect(test.id, { nodeId: e.target.value || undefined })}
                  >
                    <option value="">check: all nodes</option>
                    {nodes.map((n) => (
                      <option key={n.id} value={n.id}>
                        check: {n.data.label || n.type}
                      </option>
                    ))}
                  </Select>
                  <input
                    className="eval-input"
                    placeholder="output contains…"
                    value={test.expect.contains || ""}
                    onChange={(e) => patchExpect(test.id, { contains: e.target.value })}
                  />
                  <input
                    className="eval-input"
                    placeholder='last output equals (JSON), e.g. "ok"'
                    value={test.expect.equals || ""}
                    onChange={(e) => patchExpect(test.id, { equals: e.target.value })}
                  />
                </div>

                {r && (
                  <div className={`eval-detail ${r.pass ? "ok" : "err"}`}>
                    {r.pass ? "✓" : "✗"} {r.detail} · {r.durationMs} ms
                    {r.result && onShowResult && (
                      <button className="eval-open" onClick={() => onShowResult(r.result as ExecResult)}>
                        Show in Log console
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
