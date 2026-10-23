import { siteConfig } from '../config/site';

export class RequestTimeoutError extends Error {
  constructor() {
    super('请求超时，结果尚未确认。输入已保留，请先核对结果，避免重复提交。');
    this.name = 'RequestTimeoutError';
  }
}

// 截止时间覆盖连接与响应体读取；超时后只恢复界面，不重试写入。
export async function requestJson<Result extends { error?: string; message?: string }>(
  url: string,
  method: string,
  payload: unknown,
  failureMessage: string,
): Promise<Result> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new RequestTimeoutError());
      controller.abort();
    }, siteConfig.interactions.requestTimeoutMilliseconds);
  });
  const request = async () => {
    const multipart = payload instanceof FormData;
    const response = await fetch(url, {
      method,
      headers: multipart ? undefined : { 'Content-Type': 'application/json' },
      body: multipart ? payload : payload === undefined ? undefined : JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error(failureMessage);
    const result = await response.json() as Result;
    if (!response.ok) throw new Error(result.error || result.message || failureMessage);
    return result;
  };
  try {
    return await Promise.race([request(), deadline]);
  } finally {
    clearTimeout(timeout);
  }
}
