import type { APIRoute } from 'astro';
import { readAdminSession } from './admin-auth';
import { serverConfig } from '../config/server';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

// 所有请求按实际字节限额，不能依赖客户端声明的长度。
export async function readRequestBytes(request: Request, maximumBytes: number): Promise<Buffer> {
  if (Number(request.headers.get('content-length')) > maximumBytes) throw new HttpError(413, '请求内容过大');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, '请求内容为空');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new HttpError(413, '请求内容过大');
      }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') throw new HttpError(415, '请求格式不正确');
  let body: unknown;
  const bytes = await readRequestBytes(request, serverConfig.articleRequestMaxBytes);
  try { body = JSON.parse(bytes.toString('utf8')); }
  catch { throw new HttpError(400, '请求内容无法解析'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, '请求内容必须是对象');
  return body as Record<string, unknown>;
}

export function readPositiveId(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new HttpError(400, '编号必须是正整数');
  return value;
}

export function requireSameOrigin(request: Request) {
  if (request.headers.get('origin') !== new URL(request.url).origin) throw new HttpError(403, '请从本站提交操作');
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
