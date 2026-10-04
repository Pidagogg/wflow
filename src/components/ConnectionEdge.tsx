import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import { X } from "lucide-react";
import { createContext, useContext } from "react";

/** What an edge carried in the last run (see WorkflowEditor's edgeRunInfo). */
export interface EdgeRunInfo {
  count: number;
  /** first item the edge carried — shown on hover */
  preview?: unknown;
}

// Provided around the canvas after a run, keyed by edge id. A context instead
// of edge data, so labelling the edges never marks the workflow as changed.
export const EdgeRunContext = createContext<Record<string, EdgeRunInfo>>({});

export interface ConnectionEdgeData {
  /** Invoked with the edge id when the in‑middle delete button is clicked. */
  onDelete?: (id: string) => void;
  // index signature keeps ConnectionEdgeData assignable to Record<string, unknown>
  // (React Flow's Edge.data constraint).
  [key: string]: unknown;
}

type Props = EdgeProps<Edge<ConnectionEdgeData>>;

export default function ConnectionEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  selected,
  data,
}: Props) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const runInfo = useContext(EdgeRunContext)[id];

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    data?.onDelete?.(id);
  };

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{ ...style, stroke: selected ? "var(--cyan)" : style?.stroke }}
      />

      {runInfo && !selected && (
        <EdgeLabelRenderer>
          <div
            className={`edge-count ${runInfo.count === 0 ? "empty" : ""}`}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            title={runInfo.preview === undefined ? "No items passed here" : `First item:
${JSON.stringify(runInfo.preview, null, 2).slice(0, 800)}`}
          >
            {runInfo.count} item{runInfo.count === 1 ? "" : "s"}
          </div>
        </EdgeLabelRenderer>
      )}

      {selected && (
        <EdgeLabelRenderer>
          <div
            className="edge-delete-wrap"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            <button
              className="edge-delete-btn"
              onClick={handleDelete}
              onPointerDown={(e) => e.stopPropagation()}
              title="Delete connection"
            >
              <X size={13} />
            </button>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}