import { getDatabase } from './db';
import { HttpError } from './http';
import { requireWritableSite } from './maintenance';
import { AsyncLocalStorage } from 'node:async_hooks';

const auditScope = new AsyncLocalStorage<{ recorded: boolean }>();

export interface AdminAuditEvent {
  objectType: 'friend' | 'projects' | 'message' | 'article' | 'draft' | 'application' | 'sponsor' | 'media' | 'session';
  objectId: number | string | null;
  operation: 'create' | 'update' | 'delete' | 'restore' | 'publish' | 'withdraw' | 'star' | 'recommend' | 'reply' | 'review' | 'login' | 'logout';
  revision?: number | null;
}

// 仅接受显式对象编号及版本，不接收请求正文、来源、账号或错误详情。
export function recordAdminAudit(event: AdminAuditEvent, result: 'success' | 'conflict' | 'rejected' | 'failure') {
  getDatabase().prepare('INSERT INTO admin_audit(created_at,object_type,object_id,operation,result,revision) VALUES (?,?,?,?,?,?)')
    .run(new Date().toISOString(), event.objectType, Number.isSafeInteger(event.objectId) && Number(event.objectId) > 0 ? event.objectId
      : typeof event.objectId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(event.objectId) ? event.objectId : null,
      event.operation, result, Number.isSafeInteger(event.revision) && Number(event.revision) > 0 ? event.revision : null);
  const scope = auditScope.getStore();
  if (scope) scope.recorded = true;
}

// 鉴权后的格式错误也留最小结果；对象未知时不猜测或复制正文中的字段。
export async function withAdminAuditBoundary(request: Request, handler: () => Response | Promise<Response>) {
  const domains: Record<string, AdminAuditEvent['objectType']> = {
    friends: 'friend', projects: 'projects', messages: 'message', articles: 'article',
    applications: 'application', sponsors: 'sponsor', media: 'media', logout: 'session',
  };
  const name = new URL(request.url).pathname.match(/^\/api\/admin\/([a-z]+)\.json$/)?.[1];
  const objectType = name ? domains[name] : undefined;
  if (!objectType) return handler();
  const event: AdminAuditEvent = { objectType, objectId: null, operation: request.method === 'DELETE' ? 'delete' : request.method === 'POST' ? 'create' : 'update' };
  return auditScope.run({ recorded: false }, async () => {
    try {
      const response = await handler();
      if (!auditScope.getStore()!.recorded && response.status >= 400) recordAdminAudit(event, response.status === 409 ? 'conflict' : response.status < 500 ? 'rejected' : 'failure');
      return response;
    } catch (error) {
      if (!auditScope.getStore()!.recorded) recordAdminAudit(event, error instanceof HttpError ? error.status === 409 ? 'conflict' : 'rejected' : 'failure');
      throw error;
    }
  });
}

export function auditAdminMutation<T>(event: AdminAuditEvent, mutation: () => T): T {
  requireWritableSite();
  try {
    return getDatabase().transaction(() => {
      const result = mutation();
      recordAdminAudit(event, result === false ? 'rejected' : 'success');
      return result;
    }).immediate();
  } catch (error) {
    recordAdminAudit(event, error instanceof HttpError ? error.status === 409 ? 'conflict' : 'rejected' : 'failure');
    throw error;
  }
}
