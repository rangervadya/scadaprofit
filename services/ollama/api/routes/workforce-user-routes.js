import express from 'express';
import { randomBytes } from 'node:crypto';

/**
 * User administration routes (P2-1): list, create, reset password, update,
 * revoke sessions, global revoke, diagnostics.
 *
 * State lives in the workforce system (users/sessions arrays are reassigned on
 * mutation), so the context exposes accessor functions rather than snapshots.
 */
export function createUserAdminRouter(ctx) {
  const {
    getUsers,
    getSessions,
    setSessions,
    saveUsers,
    saveSessions,
    requireRoles,
    publicUser,
    hashPassword,
    cleanText,
    splitHumanName,
    VALID_ROLES,
    sendJsonConditional,
    deleteSession,
    deleteUserSessions,
    deleteAllSessions,
    appVersion,
    makeLogin,
    getWorkspace,
  } = ctx;

  const router = express.Router();

  router.get('/users', (req, res) => {
    if (!requireRoles(req, res, ['supervisor', 'developer'])) return;
    const users = getUsers();
    const visible =
      req.user.role === 'supervisor' ? users.filter((user) => ['fitter', 'receiver'].includes(user.role)) : users;
    return sendJsonConditional(req, res, { ok: true, users: visible.map(publicUser) });
  });

  router.post('/users', async (req, res) => {
    const users = getUsers();
    const allowedCreators = ['supervisor', 'developer'];
    if (!requireRoles(req, res, allowedCreators)) return;
    const displayName = cleanText(req.body?.displayName, 100);
    const { firstName, lastName } = splitHumanName(displayName);
    const role = String(req.body?.role || '');
    if (req.user.role === 'supervisor' && !['fitter', 'receiver'].includes(role))
      return res.status(403).json({ error: 'Руководитель может создавать только аккаунты слесарей и приёмщиков.' });
    if (!firstName || !lastName) return res.status(400).json({ error: 'Укажи имя и фамилию сотрудника.' });
    if (!VALID_ROLES.has(role)) return res.status(400).json({ error: 'Неизвестная роль.' });
    const autoGenerate = req.body?.autoGenerate !== false;
    const username = autoGenerate ? makeLogin(displayName) : cleanText(req.body?.username, 48).toLowerCase();
    const password = autoGenerate ? randomBytes(12).toString('base64url') : String(req.body?.password || '');
    if (!/^[a-z0-9._-]{3,48}$/.test(username))
      return res
        .status(400)
        .json({ error: 'Логин: от 3 до 48 символов, латиница, цифры, точка, дефис или подчёркивание.' });
    if (password.length < 10 || password.length > 200)
      return res.status(400).json({ error: 'Пароль должен содержать от 10 до 200 символов.' });
    if (ctx.isAccountCreationInProgress())
      return res.status(409).json({ error: 'Создание другого аккаунта уже выполняется. Повтори попытку.' });
    ctx.setAccountCreationInProgress(true);
    try {
      if (users.some((user) => user.username.toLowerCase() === username))
        return res.status(409).json({ error: 'Такой логин уже занят.' });
      if (
        role === 'supervisor' &&
        users.filter((user) => user.role === 'supervisor' && user.active !== false).length >= 2
      )
        return res.status(409).json({ error: 'Можно создать только двух действующих руководителей.' });
      const user = {
        id: globalThis.crypto.randomUUID(),
        username,
        displayName,
        firstName,
        lastName,
        role,
        passwordHash: await hashPassword(password),
        active: true,
        createdAt: new Date().toISOString(),
      };
      users.push(user);
      await saveUsers();
      req.log.info(
        { userId: user.id, role, username, generated: autoGenerate, createdBy: req.user.id },
        'Account created',
      );
      return res
        .status(201)
        .json({ ok: true, user: publicUser(user), credentials: { username, password, generated: autoGenerate } });
    } finally {
      ctx.setAccountCreationInProgress(false);
    }
  });

  router.post('/users/:id/reset-password', async (req, res) => {
    if (!requireRoles(req, res, ['supervisor', 'developer'])) return;
    const users = getUsers();
    const user = users.find((item) => item.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'Аккаунт не найден.' });
    if (!['fitter', 'receiver'].includes(user.role))
      return res
        .status(403)
        .json({ error: 'Через базу сотрудников можно переиздать пароль только слесарю или приёмщику.' });
    const password = randomBytes(15).toString('base64url');
    user.passwordHash = await hashPassword(password);
    user.updatedAt = new Date().toISOString();
    // Revoke previous sessions so the new password takes effect immediately.
    setSessions(getSessions().filter((session) => session.userId !== user.id));
    await Promise.all([saveUsers(), saveSessions()]);
    await deleteUserSessions(user.id);
    req.log.warn(
      { userId: user.id, role: user.role, resetBy: req.user.id },
      'Password reset issued and sessions revoked',
    );
    return res.json({
      ok: true,
      user: publicUser(user),
      credentials: { username: user.username, password, reset: true },
    });
  });

  router.patch('/users/:id', async (req, res) => {
    if (!requireRoles(req, res, ['developer'])) return;
    const users = getUsers();
    const user = users.find((item) => item.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'Аккаунт не найден.' });
    const displayName = req.body?.displayName === undefined ? user.displayName : cleanText(req.body.displayName, 100);
    const { firstName, lastName } = splitHumanName(displayName);
    const role = req.body?.role === undefined ? user.role : String(req.body.role);
    const active = req.body?.active === undefined ? user.active !== false : Boolean(req.body.active);
    const nextPassword = req.body?.password ? String(req.body.password) : '';
    if (!firstName || !lastName || !VALID_ROLES.has(role))
      return res.status(400).json({ error: 'Проверь имя, фамилию и роль.' });
    if (nextPassword && (nextPassword.length < 10 || nextPassword.length > 200))
      return res.status(400).json({ error: 'Новый пароль должен содержать от 10 до 200 символов.' });
    if (user.id === req.user.id && (!active || role !== 'developer'))
      return res.status(400).json({ error: 'Нельзя отключить или понизить собственный аккаунт разработчика.' });
    if (role === 'supervisor' && active && !(user.role === 'supervisor' && user.active !== false)) {
      const otherActiveSupervisors = users.filter(
        (item) => item.id !== user.id && item.role === 'supervisor' && item.active !== false,
      ).length;
      if (otherActiveSupervisors >= 2) return res.status(409).json({ error: 'Уже есть два действующих руководителя.' });
    }
    if (
      user.role === 'developer' &&
      (role !== 'developer' || !active) &&
      users.filter((item) => item.role === 'developer' && item.active !== false).length <= 1
    )
      return res.status(409).json({ error: 'Нельзя отключить или убрать последнего разработчика.' });
    user.displayName = displayName;
    user.firstName = firstName;
    user.lastName = lastName;
    user.role = role;
    user.active = active;
    user.updatedAt = new Date().toISOString();
    if (nextPassword) user.passwordHash = await hashPassword(nextPassword);
    if (!active) {
      setSessions(getSessions().filter((session) => session.userId !== user.id));
      await saveSessions();
      await deleteUserSessions(user.id);
    }
    await saveUsers();
    return res.json({ ok: true, user: publicUser(user) });
  });

  router.post('/users/:id/revoke-sessions', async (req, res) => {
    if (!requireRoles(req, res, ['developer'])) return;
    const users = getUsers();
    const user = users.find((item) => item.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'Аккаунт не найден.' });
    const before = getSessions().length;
    setSessions(getSessions().filter((session) => session.userId !== user.id));
    await saveSessions();
    await deleteUserSessions(user.id);
    req.log.warn(
      { userId: user.id, revoked: before - getSessions().length, by: req.user.id },
      'All sessions revoked for user',
    );
    return res.json({ ok: true, revoked: before - getSessions().length });
  });

  router.post('/admin/revoke-all-sessions', async (req, res) => {
    if (!requireRoles(req, res, ['developer'])) return;
    const before = getSessions().length;
    const revoked = getSessions().map((item) => item.tokenHash);
    setSessions([]);
    await deleteAllSessions();
    await Promise.all(revoked.map((hash) => deleteSession(hash)));
    req.log.warn({ revoked: before, by: req.user.id }, 'All sessions revoked globally');
    return res.json({ ok: true, revoked: before });
  });

  router.get('/admin/diagnostics', (req, res) => {
    if (!requireRoles(req, res, ['developer'])) return;
    const workspace = getWorkspace();
    return res.json({
      ok: true,
      version: appVersion(),
      node: process.version,
      users: getUsers().length,
      tasks: workspace.tasks.length,
      reports: workspace.reports.length,
      defectReports: workspace.defectReports.length,
      sessions: getSessions().length,
      gpsTracking: false,
      manualSketchCadQueue: true,
      unifiedInbox: true,
      taskScopedConclusionTransfer: true,
      addressFolderInbox: true,
      atomicFolderConclusionTransfer: true,
      appendix3DefectPhotos: true,
      multiHouseDispatch: true,
      receiverCanAssignFitters: true,
      dataStore: 'persistent-json',
    });
  });

  return router;
}
