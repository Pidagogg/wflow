export interface ToolInput {
  name: string;
  description: string;
  /** the trigger's own spelling of the field ("full name" for full_name) */
  field?: string;
  type?: "string" | "number" | "boolean" | "enum";
  required?: boolean;
  options?: string[];
  example?: string;
}
export declare function toolInputsFor(wf: { nodes?: Array<{ type?: string; data?: { config?: Record<string, unknown> } }>; mcp?: { params?: ToolInput[] } }): {
  params: ToolInput[];
  source: string;
};
