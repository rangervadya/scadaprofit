import type { SessionUser } from './types';

export const STAFF_ROLES: SessionUser['role'][] = ['receiver', 'supervisor', 'developer'];

export function isStaffRole(role: SessionUser['role'] | undefined | null): boolean {
  return Boolean(role && STAFF_ROLES.includes(role));
}
