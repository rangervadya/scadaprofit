import { hasPermission } from '../../frontend/src/lib/permissions.mjs';

const rules = [
  ['GET', /^\/api\/auth\/(me|check-vdgo)$/, 'conclusion:generate'],
  ['GET', /^\/api\/workforce\/events$/, 'team:view'],
  ['GET', /^\/api\/workforce\/tasks(?:\/[^/]+)?$/, 'task:view'],
  ['POST', /^\/api\/workforce\/tasks$/, 'task:assign'],
  ['PATCH', /^\/api\/workforce\/tasks\/[^/]+$/, 'task:reassign'],
  ['DELETE', /^\/api\/workforce\/tasks\/[^/]+$/, 'task:delete'],
  ['POST', /^\/api\/workforce\/tasks\/[^/]+\/(start|visit|office|report|defects)$/, 'task:submit'],
  ['POST', /^\/api\/workforce\/(tasks|reports|defects)\/[^/]+\/conclusion$/, 'review:manage'],
  ['GET', /^\/api\/workforce\/(reports|defects|overview|conclusion)$/, 'review:manage'],
  ['POST', /^\/api\/workforce\/(reports|defects)\/[^/]+\/(seen|review|cancel-analysis)$/, 'review:manage'],
  ['GET', /^\/api\/workforce\/(reports|defects)\/[^/]+\/files\/[^/]+$/, 'team:view'],
  ['GET|POST|PATCH', /^\/api\/workforce\/users(?:\/[^/]+(?:\/reset-password)?)?$/, 'users:manage'],
  ['GET|POST|DELETE', /^\/api\/template(?:\/file)?$/, 'system:settings'],
  ['GET|PUT|POST|DELETE', /^\/api\/(moss-settings|openrouter-settings)(?:\/test)?$/, 'system:settings'],
  ['GET|POST', /^\/api\/library(?:\/(?:streets|buildings|schemes\/upload|schemes\/[^/]+(?:\/(?:status|analyze))?))?$/, 'schemes:manage'],
  ['GET|POST', /^\/api\/jobs\/[^/]+\/(graph|connections|review)$/, 'schemes:manage'],
  ['POST', /^\/api\/analyze$/, 'schemes:manage'],
  ['GET|POST|PUT', /^\/api\/manual-cad\/(?:projects(?:\/[^/]+(?:\/(?:source|preview\.svg|export\.svg|export\.dxf))?)?|import-(?:job|source-job|workforce-report)\/[^/]+)$/, 'cad:manage'],
  ['GET', /^\/jobs\//, 'schemes:manage'],
  ['POST', /^\/api\/conclusion\/json\/import$/, 'conclusion:json:import'],
  ['POST', /^\/api\/conclusion\/json\/export$/, 'conclusion:json:export'],
];

export function requiredPermission(method, pathname) {
  if (pathname === '/api/auth/me') return 'team:view';
  return rules.find(([methods, pattern]) => methods.split('|').includes(method) && pattern.test(pathname))?.[2];
}

export function denyAccess(req, res, message = 'Недостаточно прав для этого действия.') {
  const status = req.user ? 403 : 401;
  console.warn(JSON.stringify({
    event: 'access_denied', userId: req.user?.id || null, role: req.user?.role || null,
    method: req.method, endpoint: req.path, at: new Date().toISOString(),
  }));
  return res.status(status).json({ error: status === 401 ? 'Требуется войти в аккаунт.' : message });
}

export function authorizeRequest(req, res) {
  const permission = requiredPermission(req.method, req.path);
  if (req.user?.role === 'developer' || hasPermission(req.user?.role, permission)) return true;
  denyAccess(req, res);
  return false;
}
