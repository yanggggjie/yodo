export function parseUrl(raw: string): { bareUrl: string; query: Record<string, string> };
export function serializeUrl(value: { bareUrl: string; query?: Record<string, string> }): string;
