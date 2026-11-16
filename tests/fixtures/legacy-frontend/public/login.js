'use strict';
const $ = id => document.getElementById(id);
let setupMode = false;
async function request(url, options = {}) {
  const response = await fetch(url, { cache: 'no-store', ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Ошибка ${response.status}`);
  return data;
}
async function initialise() {
  try {
    const current = await request('/api/auth/me');
    if (current.user) { window.location.replace('/workforce.html'); return; }
  } catch { /* not signed in yet */ }
  try {
    const status = await request('/api/auth/status');
    setupMode = Boolean(status.setupRequired);
    if (setupMode) {
      $('pageTitle').textContent = 'Создание разработчика';
      $('pageDescription').textContent = 'Создай главный аккаунт. После входа ты сможешь завести отдельных пользователей для слесарей, приёмщика и двух руководителей.';
      $('nameField').hidden = false;
      $('displayName').required = true;
      $('setupHint').hidden = false;
      $('submitBtn').textContent = 'Создать аккаунт разработчика';
    }
  } catch (error) { $('message').textContent = error.message; }
}
$('authForm').addEventListener('submit', async event => {
  event.preventDefault();
  $('message').textContent = '';
  $('submitBtn').disabled = true;
  try {
    const body = { username: $('username').value.trim(), password: $('password').value };
    if (setupMode) body.displayName = $('displayName').value.trim();
    const data = await request(setupMode ? '/api/auth/setup' : '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    if (!data.user) throw new Error('Сервер не вернул пользователя.');
    window.location.replace('/workforce.html');
  } catch (error) {
    $('message').textContent = error.message;
    $('submitBtn').disabled = false;
  }
});
initialise();
