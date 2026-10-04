import { GraduationCap, X } from "lucide-react";

interface Props {
  onOpenTutorial: () => void;
  onClose: () => void;
}

const STEPS = [
  { title: "Open the builder", text: "The Workflows tab lets you create or open an automation in the editor." },
  { title: "Add a trigger", text: "Add node → pick a trigger (Manual, Webhook, Schedule or a service). It appears on the canvas." },
  { title: "Connect nodes", text: "Drag from a node's right handle to the next node's left handle to chain them." },
  { title: "Configure & run", text: "Click a node to set it up, then hit Run and watch each node's input/output in the Log console." },
];

export default function WelcomeWizard({ onOpenTutorial, onClose }: Props) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="modal modal-welcome" role="dialog" aria-modal="true" aria-label="Getting started" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="modal-title">Getting started</div>
            <div className="modal-sub">Build your first workflow in under a minute.</div>
          </div>
          <button className="modal-x" onClick={onClose} title="Close">
            <X size={14} />
          </button>
        </div>

        <div className="steps" style={{ padding: 6 }}>
          {STEPS.map((s, i) => (
            <div className="step" key={s.title}>
              <div className="step-num">{i + 1}</div>
              <div className="step-body">
                <div className="step-title">{s.title}</div>
                <div className="step-text">{s.text}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="welcome-actions">
          <button className="btn btn-sm" onClick={onOpenTutorial}>
            <GraduationCap size={12} /> Full tutorial
          </button>
          <button className="btn btn-sm btn-primary" onClick={onClose} style={{ marginLeft: "auto" }}>
            Start building →
          </button>
        </div>
      </div>
    </div>
  );
}