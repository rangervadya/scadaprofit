export const PERMISSIONS: Record<string, readonly string[]>;
export const SECTIONS: Record<string, string>;
export function hasPermission(role: string | null | undefined, permission: string): boolean;
