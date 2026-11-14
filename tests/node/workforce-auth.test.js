import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, authenticateCredentials } from '../../services/ollama/api/workforce-system.js';

test('password hashes are salted and cannot be used as plain-text credentials', async () => {
  const first = await hashPassword('A-very-strong-Password-1');
  const second = await hashPassword('A-very-strong-Password-1');
  assert.notEqual(first, second, 'each password hash must use a fresh salt');
  assert.equal(await verifyPassword('A-very-strong-Password-1', first), true);
  assert.equal(await verifyPassword('wrong-password', first), false);
  assert.equal(await verifyPassword('A-very-strong-Password-1', 'broken-hash'), false);
});

test('login accepts only a matching existing username and password', async () => {
  const users = [
    {
      id: 'fitter-1',
      username: 'ivan.petrov',
      role: 'fitter',
      active: true,
      passwordHash: await hashPassword('Fitter-Pass-2026!'),
    },
    {
      id: 'receiver-1',
      username: 'anna.receiver',
      role: 'receiver',
      active: true,
      passwordHash: await hashPassword('Receiver-Pass-2026!'),
    },
    {
      id: 'disabled-1',
      username: 'disabled.user',
      role: 'fitter',
      active: false,
      passwordHash: await hashPassword('Disabled-Pass-2026!'),
    },
  ];

  assert.equal((await authenticateCredentials(users, 'IVAN.PETROV', 'Fitter-Pass-2026!'))?.id, 'fitter-1');
  assert.equal((await authenticateCredentials(users, 'anna.receiver', 'Receiver-Pass-2026!'))?.id, 'receiver-1');
  assert.equal(await authenticateCredentials(users, 'ivan.petrov', 'not-the-password'), null);
  assert.equal(await authenticateCredentials(users, 'unknown.account', 'Fitter-Pass-2026!'), null);
  assert.equal(await authenticateCredentials(users, 'disabled.user', 'Disabled-Pass-2026!'), null);
  assert.equal(await authenticateCredentials(users, '', ''), null);
});

test('request schemas reject malformed bodies and normalize valid ones', async () => {
  const { loginSchema, setupSchema, streetSchema, buildingSchema, connectionSchema, reviewSchema } =
    await import('../../services/ollama/api/schemas.js');

  assert.equal(loginSchema.safeParse({ username: '  ivan.petrov  ', password: 'secret' }).success, true);
  assert.equal(loginSchema.safeParse({ username: '', password: 'secret' }).success, false);
  assert.equal(loginSchema.safeParse({ username: 'ivan', password: '' }).success, false);

  const setup = setupSchema.safeParse({
    username: ' IVAN.PETROV ',
    displayName: 'Иван Петров',
    password: 'Strong-Pass-2026',
  });
  assert.equal(setup.success, true);
  assert.equal(setup.data.username, 'ivan.petrov');
  assert.equal(
    setupSchema.safeParse({ username: 'ab', displayName: 'Иван', password: 'Strong-Pass-2026' }).success,
    false,
  );
  assert.equal(setupSchema.safeParse({ username: 'ivan', displayName: 'Иван', password: 'short' }).success, false);

  assert.equal(streetSchema.safeParse({ name: '  Ленина  ' }).data.name, 'Ленина');
  assert.equal(streetSchema.safeParse({ name: '' }).success, false);
  assert.equal(buildingSchema.safeParse({ streetId: 's1', name: '15' }).success, true);
  assert.equal(buildingSchema.safeParse({ streetId: 's1', name: '' }).success, false);

  assert.equal(connectionSchema.safeParse({ from: 'a', to: 'b', confirmAlternative: false }).success, true);
  assert.equal(connectionSchema.safeParse({ from: 'a', to: 'b', confirmAlternative: 'yes' }).success, false);
  assert.equal(reviewSchema.safeParse({ action: 'confirm', targetId: 't1', rotation: 90 }).success, true);
  assert.equal(reviewSchema.safeParse({ action: '', targetId: 't1' }).success, false);
});
