import { createHash } from 'node:crypto';

/**
 * Conditional-GET helper for JSON read endpoints (P2-2).
 *
 * Builds a weak ETag from the response body, advertises
 * `Cache-Control: private, no-cache`, and answers `304 Not Modified` when the
 * client sends a matching `If-None-Match`. This keeps payload sizes down for
 * polling clients without caching stale data (no max-age).
 */
export function sendJsonConditional(req, res, payload) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const etag = `W="${createHash('sha1').update(body).digest('base64url')}"`;
  res.set('ETag', etag);
  res.set('Cache-Control', 'private, no-cache');
  const inm = req.headers?.['if-none-match'];
  if (inm === etag) {
    res.status(304).end();
    return;
  }
  res.type('application/json').send(body);
}
