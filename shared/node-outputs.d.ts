export declare const OUTPUTS: Record<string, string>;
export declare function outputDocFor(type: string, def: unknown): string;
export declare function outputHandlesFor(node: { type?: string; data?: { config?: Record<string, unknown> } } | undefined, def: unknown): string[];
