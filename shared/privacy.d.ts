// Types for shared/privacy.js (plain JS module, imported by the editor).
export declare const PRIVATE_FIELD_NAMES: Set<string>;
export declare function hasLiteralValue(value: unknown): boolean;
export declare function stripPrivateFromConfig<T extends Record<string, unknown> | undefined>(config: T): T;
export declare function stripPrivateFromWorkflow<T extends { nodes?: unknown[] }>(wf: T): T;
