import type { APIRoute } from 'astro';
import { readAdminSession } from './admin-auth';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') throw new HttpError(415, '请求格式不正确');
  let body: unknown;
  try { body = await request.json(); }
  catch { throw new HttpError(400, '请求内容无法解析'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, '请求内容必须是对象');
  return body as Record<string, unknown>;
}

export function readPositiveId(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new HttpError(400, '编号必须是正整数');
  return value;
}

// API 错误分类与管理鉴权边界
export function errorResponse(error: unknown) {
  if (error instanceof HttpError) return json({ error: error.message }, error.status);
  if (error instanceof Error && 'code' in error && error.code === 'SQLITE_CONSTRAINT_UNIQUE') return json({ error: '这个地址已经存在' }, 409);
  console.error('API request failed', error);
  return json({ error: '服务暂时无法完成请求，请稍后再试' }, 500);
}

export const route = (handler: APIRoute): APIRoute => async (context) => {
  try { return await handler(context); }
  catch (error) { return errorResponse(error); }
};

export const adminRoute = (handler: APIRoute): APIRoute => route((context) => {
  if (!readAdminSession(context.cookies)) return json({ error: '未授权' }, 401);
  return handler(context);
});
