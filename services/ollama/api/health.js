import { spawn } from 'node:child_process';

/**
 * Dependency probes for health/readiness (P2-1).
 *
 * Extracted from server.js: Tesseract detection (cached), Ollama reachability
 * and model presence, plus the model name from the environment.
 */
export function createHealthChecks({ modelName = () => process.env.QWEN_MODEL || 'qwen3-vl:4b-instruct' } = {}) {
  let tesseractCache = { checkedAt: 0, value: null };

  function checkTesseract() {
    return new Promise((resolve) => {
      let output = '';
      let settled = false;
      let timer = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const child = spawn('tesseract', ['--list-langs'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        output += chunk.toString();
      });
      child.on('error', (error) =>
        finish({ available: false, languages: [], error: String(error.message || error).slice(0, 180) }),
      );
      child.on('close', (code) => {
        const languages = output
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => /^[a-z]{3}$/.test(line));
        finish({
          available: code === 0,
          languages,
          russianEnglishReady: code === 0 && languages.includes('rus') && languages.includes('eng'),
          error: code === 0 ? null : `tesseract --list-langs завершился с кодом ${code}`,
        });
      });
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish({ available: false, languages: [], error: 'Проверка Tesseract превысила 4 секунды.' });
      }, 4000);
    });
  }

  async function checkTesseractCached(maxAgeMs = 30_000) {
    const now = Date.now();
    if (tesseractCache.value && now - tesseractCache.checkedAt < maxAgeMs) return tesseractCache.value;
    const value = await checkTesseract();
    tesseractCache = { checkedAt: now, value };
    return value;
  }

  async function checkOllamaStatus() {
    const qwenModel = modelName();
    const tagsUrl =
      process.env.OLLAMA_TAGS_URL ||
      (process.env.OLLAMA_CHAT_URL || 'http://127.0.0.1:11434/api/chat').replace(/\/api\/chat\/?$/, '/api/tags');

    const ollama = { reachable: false, modelInstalled: false, model: qwenModel, error: null, hint: null };
    try {
      const response = await fetch(tagsUrl, { cache: 'no-store', signal: AbortSignal.timeout(3500) });
      if (!response.ok) throw new Error(`Ollama API вернула HTTP ${response.status}`);
      const data = await response.json();
      const models = Array.isArray(data.models) ? data.models : [];
      const names = models.map((item) => String(item.name || item.model || '')).filter(Boolean);
      ollama.reachable = true;
      ollama.models = names;
      ollama.modelInstalled = names.some(
        (name) =>
          name === qwenModel ||
          name === `${qwenModel}:latest` ||
          name.replace(/:latest$/, '') === qwenModel.replace(/:latest$/, ''),
      );
      if (!ollama.modelInstalled) {
        ollama.error = `Модель ${qwenModel} не найдена. Установлены: ${names.join(', ') || 'нет моделей'}.`;
        ollama.hint = `Выполните: docker compose exec ollama ollama pull ${qwenModel}`;
      }
    } catch (error) {
      ollama.error = String(error?.message || error).slice(0, 240);
      ollama.hint = 'Проверьте, что Ollama запущена и доступна по OLLAMA_TAGS_URL из контейнера app.';
    }
    return ollama;
  }

  return { checkTesseract, checkTesseractCached, checkOllamaStatus, modelName };
}
