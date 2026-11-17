const staff = ['receiver', 'supervisor', 'developer'];
const managers = ['supervisor', 'developer'];
const everyone = ['fitter', ...staff];

export const PERMISSIONS = {
  'dashboard:view': everyone,
  'team:view': everyone,
  'task:stages:view': staff,
  'task:view': everyone,
  'task:submit': ['fitter', 'developer'],
  'task:assign': staff,
  'task:delete': staff,
  'task:reassign': staff,
  'review:manage': staff,
  'conclusion:fill': everyone,
  'conclusion:generate': staff,
  'conclusion:json:import': ['developer'],
  'conclusion:json:export': ['developer'],
  'schemes:manage': staff,
  'archive:view': staff,
  'cad:manage': staff,
  'users:manage': managers,
  'system:settings': ['developer'],
};

export const SECTIONS = {
  '/': 'dashboard:view',
  '/team': 'team:view',
  '/conclusion': 'conclusion:fill',
  '/schemes': 'schemes:manage',
  '/archive': 'archive:view',
  '/cad': 'cad:manage',
  '/settings': 'system:settings',
};

export function hasPermission(role, permission) {
  return Boolean(PERMISSIONS[permission]?.includes(role));
}
