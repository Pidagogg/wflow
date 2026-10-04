// Types for shared/workflow-merge.js (plain JS module, imported by the editor).
import type { FlowEdge, FlowNode } from "../src/types";

/** The workflow graph as it is stored — both sides of a merge use this shape. */
export interface MergeableWorkflow {
  nodes?: FlowNode[];
  edges?: FlowEdge[];
}

export interface MergeResult {
  /** the imported nodes, re-identified and shifted next to the host graph */
  nodes: FlowNode[];
  /** the imported edges, re-pointed at the new node ids */
  edges: FlowEdge[];
  stats: { nodes: number; edges: number };
}

export declare const MERGE_GAP_X: number;

export declare function mergeWorkflows(host: MergeableWorkflow, incoming: MergeableWorkflow): MergeResult;
