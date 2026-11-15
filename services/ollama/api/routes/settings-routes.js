import express from 'express';

/**
 * Cloud provider settings routes (P2-1).
 *
 * The cloud AI integrations (OpenRouter, MOSS) are intentionally disabled: the
 * product runs a local Qwen3-VL + Tesseract pipeline. These routes stay for
 * backward compatibility with older clients and always report "disabled".
 */
export function createSettingsRouter() {
  const router = express.Router();

  const disabled = (_req, res) =>
    res.status(410).json({
      ok: false,
      disabled: true,
      error: 'Облачные AI-провайдеры отключены. Используется локальная связка Qwen3-VL + Tesseract.',
    });

  router.get('/openrouter-settings', (_req, res) =>
    res.json({
      ok: true,
      disabled: true,
      openrouter: { configured: false, enabled: false },
      local: { mode: 'Qwen3-VL + Tesseract' },
    }),
  );
  router.put('/openrouter-settings', disabled);
  router.delete('/openrouter-settings', disabled);
  router.post('/openrouter-settings/test', disabled);

  router.get('/moss-settings', (_req, res) =>
    res.json({
      ok: true,
      disabled: true,
      moss: { configured: false, enabled: false },
      local: { mode: 'Qwen3-VL + Tesseract' },
    }),
  );
  router.put('/moss-settings', disabled);
  router.delete('/moss-settings', disabled);
  router.post('/moss-settings/test', disabled);

  return router;
}
