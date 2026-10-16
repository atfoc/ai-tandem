export const outFile: string;
export function packageRoot(name: string): string;
export function buildEngine(options?: { ifStale?: boolean }): Promise<string>;
