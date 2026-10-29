export function validateStyles(config: Record<string, unknown>, types: Record<string, string>): void;
export function listAnalysisVisualizations(): Record<string, unknown>[];
export function inspectAnalysisStyles(config: Record<string, unknown>, types: Record<string, string>, column?: string): Record<string, unknown>;
export function analysisReference(section: string, search?: string, limit?: number): Record<string, unknown>;
