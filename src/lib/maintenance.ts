import { serverConfig } from '../config/server';
import { HttpError, json } from './http';

// 维护期只开放无副作用读取；数据库另外使用只读连接兜底。
export const isMaintenanceMode = () => serverConfig.maintenanceMode;
export function requireWritableSite() {
  if (isMaintenanceMode()) throw new HttpError(503, '站点维护中，暂时无法保存，请稍后重试');
}
export function maintenanceResponse() {
  const response = json({ error: '站点维护中，暂时无法保存，请稍后重试' }, 503);
  response.headers.set('Retry-After', String(serverConfig.maintenanceRetrySeconds));
  return response;
}
