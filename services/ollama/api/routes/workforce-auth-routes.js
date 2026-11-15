import express from 'express';
import { randomUUID } from 'node:crypto';

/**
 * Authentication routes (P2-1): status, setup, login, logout, me, check-vdgo.
 *
 * Mutating handlers receive the state through accessors because `users` and
 * `sessions` are reassigned on change.
 */
export function createAuthRouter(ctx) {
  const {
    getUsers,
    getSessions,
    setSessions,
    saveUsers,
    saveSessions,
    cleanText,
    hashPassword,
    publicUser,
    authenticateCredentials,
    tokenHash,
    cookieValue,
    clearSessionCookie,
    deleteSession,
    validateBody,
    setupSchema,
    loginSchema,
    SESSION_COOKIE,
    sessionForUser,
    getCurrentUser,
    isSetupInProgress,
    setSetupInProgress,
    secureCookies,
  } = ctx;

  const router = express.Router();

  router.get('/auth/status', (_req, res) => res.json({ ok: true, setupRequired: getUsers().length === 0 }));

  router.post('/auth/setup', validateBody(setupSchema), async (req, res) => {
    const users = getUsers();
    if (users.length || isSetupInProgress())
      return res
        .status(409)
        .json({ error: 'Первоначальная настройка уже выполняется или завершена. Войди под аккаунтом разработчика.' });
    const username = cleanText(req.body?.username, 48).toLowerCase();
    const displayName = cleanText(req.body?.displayName, 100);
    const password = String(req.body?.password || '');
    if (!/^[a-z0-9._-]{3,48}$/.test(username))
      return res
        .status(400)
        .json({ error: 'Логин: от 3 до 48 символов, латиница, цифры, точка, дефис или подчёркивание.' });
    if (password.length < 10 || password.length > 200)
      return res.status(400).json({ error: 'Пароль должен содержать от 10 до 200 символов.' });
    if (!displayName) return res.status(400).json({ error: 'Укажи имя разработчика.' });
    setSetupInProgress(true);
    try {
      if (getUsers().length) return res.status(409).json({ error: 'Первоначальная настройка уже завершена.' });
      const user = {
        id: randomUUID(),
        username,
        displayName,
        role: 'developer',
        passwordHash: await hashPassword(password),
        active: true,
        createdAt: new Date().toISOString(),
      };
      getUsers().push(user);
      await saveUsers();
      await sessionForUser(res, user);
      return res.status(201).json({ ok: true, user: publicUser(user) });
    } finally {
      setSetupInProgress(false);
    }
  });

  router.post('/auth/login', validateBody(loginSchema), async (req, res) => {
    const user = await authenticateCredentials(getUsers(), req.body?.username, req.body?.password);
    if (!user) {
      req.log.warn(
        { username: cleanText(req.body?.username, 48), requestId: req.id },
        'Rejected login: unknown user or wrong password',
      );
      return res.status(401).json({ error: 'Неверный логин или пароль.' });
    }
    await sessionForUser(res, user);
    req.log.info({ userId: user.id, role: user.role }, 'User signed in');
    return res.json({ ok: true, user: publicUser(user) });
  });

  router.post('/auth/logout', async (req, res) => {
    const token = cookieValue(req.headers.cookie, SESSION_COOKIE);
    const hash = token ? tokenHash(token) : '';
    setSessions(getSessions().filter((item) => item.tokenHash !== hash));
    await saveSessions();
    await deleteSession(hash);
    clearSessionCookie(res, secureCookies);
    return res.json({ ok: true });
  });

  router.get('/auth/me', (req, res) => {
    const user = getCurrentUser(req);
    if (!user) return res.status(401).json({ error: 'Войди в аккаунт.' });
    return res.json({ ok: true, user: publicUser(user) });
  });

  router.get('/auth/check-vdgo', (_req, res) => res.sendStatus(204));

  return router;
}
