import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, authenticateCredentials } from '../../backend/api/workforce-system.js';

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
    { id: 'fitter-1', username: 'ivan.petrov', role: 'fitter', active: true, passwordHash: await hashPassword('Fitter-Pass-2026!') },
    { id: 'receiver-1', username: 'anna.receiver', role: 'receiver', active: true, passwordHash: await hashPassword('Receiver-Pass-2026!') },
    { id: 'disabled-1', username: 'disabled.user', role: 'fitter', active: false, passwordHash: await hashPassword('Disabled-Pass-2026!') }
  ];

  assert.equal((await authenticateCredentials(users, 'IVAN.PETROV', 'Fitter-Pass-2026!'))?.id, 'fitter-1');
  assert.equal((await authenticateCredentials(users, 'anna.receiver', 'Receiver-Pass-2026!'))?.id, 'receiver-1');
  assert.equal(await authenticateCredentials(users, 'ivan.petrov', 'not-the-password'), null);
  assert.equal(await authenticateCredentials(users, 'unknown.account', 'Fitter-Pass-2026!'), null);
  assert.equal(await authenticateCredentials(users, 'disabled.user', 'Disabled-Pass-2026!'), null);
  assert.equal(await authenticateCredentials(users, '', ''), null);
});
