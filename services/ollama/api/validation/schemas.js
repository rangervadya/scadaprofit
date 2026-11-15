import { z } from 'zod';

/**
 * Runtime contracts for request bodies.
 *
 * These schemas are deliberately small and explicit: they protect the routes
 * that already have a stable shape. Complex CAD payloads are normalized by
 * manual-cad-core, and the VDGO conclusion form keeps its own field-level
 * validation until it is moved behind Pydantic.
 */
export const loginSchema = z.object({
  username: z.string().trim().min(1, 'Укажи логин.').max(80),
  password: z.string().min(1, 'Укажи пароль.').max(200),
});

export const setupSchema = z.object({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .min(3, 'Логин: от 3 до 48 символов.')
    .max(48)
    .regex(/^[a-z0-9._-]+$/, 'Логин: латиница, цифры, точка, дефис или подчёркивание.'),
  displayName: z.string().trim().min(1, 'Укажи имя разработчика.').max(100),
  password: z.string().min(10, 'Пароль должен содержать от 10 до 200 символов.').max(200),
});

export const streetSchema = z.object({
  name: z.string().trim().min(1, 'Укажи название улицы.').max(120),
});

export const buildingSchema = z.object({
  streetId: z.string().trim().min(1, 'Выбери улицу.').max(120),
  name: z.string().trim().min(1, 'Укажи номер дома.').max(40),
});

export const manualProjectCreateSchema = z.object({
  title: z.string().trim().max(140).optional(),
});

export const connectionSchema = z.object({
  from: z.string().trim().min(1).max(80),
  to: z.string().trim().min(1).max(80),
  candidateId: z.string().trim().max(80).nullable().optional(),
  confirmAlternative: z.boolean().optional(),
});

export const reviewSchema = z
  .object({
    action: z.string().trim().min(1).max(40),
    targetId: z.string().trim().min(1).max(80),
    symbolType: z.string().trim().max(40).optional(),
    rotation: z.number().finite().optional(),
    pipeId: z.string().trim().max(80).optional(),
    value: z.string().max(200).optional(),
    text: z.string().max(500).optional(),
  })
  .passthrough();

function firstIssue(error) {
  const issue = error.issues?.[0];
  const field = issue?.path?.length ? issue.path.join('.') : 'body';
  return { field, message: issue?.message || 'Некорректное значение.' };
}

export function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) {
      const { field, message } = firstIssue(result.error);
      const error = new Error(`${field}: ${message}`);
      error.status = 422;
      error.code = 'VALIDATION_ERROR';
      error.details = result.error.issues.map((item) => ({
        field: item.path.length ? item.path.join('.') : 'body',
        message: item.message,
      }));
      return next(error);
    }
    req.body = result.data;
    return next();
  };
}

export function parseBody(schema, body) {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    const { field, message } = firstIssue(result.error);
    const error = new Error(`${field}: ${message}`);
    error.status = 422;
    error.code = 'VALIDATION_ERROR';
    error.details = result.error.issues.map((item) => ({
      field: item.path.length ? item.path.join('.') : 'body',
      message: item.message,
    }));
    throw error;
  }
  return result.data;
}
