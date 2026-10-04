export interface ValidationIssue {
  severity: "error" | "warning";
  /** JSON path of the problem, e.g. nodes[2].data.config.url ("" = the whole workflow) */
  path: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
}
export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}
export declare function validateWorkflow(wf: unknown, opts: { nodes: Record<string, unknown> }): ValidationResult;
export declare function fieldsBefore(wf: unknown, nodeId: string, opts: { nodes: Record<string, unknown> }): { fields: string[]; open: boolean };
export declare function formatIssues(result: { errors?: ValidationIssue[]; warnings?: ValidationIssue[] }, limit?: number): string;
