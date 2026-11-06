import { readerConfig } from '../config/readers';
import { HttpError } from './http';

const endpoints = {
  token: 'https://www.blogsclub.org/Oauth/getOauthData?action=token',
  profile: 'https://www.blogsclub.org/Oauth/getOauthData?action=userinfo',
  email: 'https://api.resend.com/emails',
};

// 只访问固定认证服务；截止时间包含正文，不跟随重定向，也不传播含令牌的底层异常。
export async function readerUpstreamRequest(endpoint: keyof typeof endpoints, options: RequestInit, accessToken?: string): Promise<Record<string, unknown>> {
  const url = new URL(endpoints[endpoint]);
  if (endpoint === 'profile' && accessToken) url.searchParams.set('access_token', accessToken);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new HttpError(502, '登录服务响应超时，请稍后重试')); }, readerConfig.upstreamTimeoutMilliseconds);
  });
  try {
    return await Promise.race([deadline, (async () => {
      const response = await fetch(url, { ...options, redirect: 'error', signal: controller.signal });
      if (!response.ok || Number(response.headers.get('content-length')) > readerConfig.upstreamMaximumBytes || !response.body) {
        void response.body?.cancel().catch(() => {});
        throw new HttpError(502, '登录服务暂不可用，请稍后重试');
      }
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > readerConfig.upstreamMaximumBytes) throw new HttpError(502, '登录服务响应格式不正确');
        chunks.push(chunk.value);
      }
      const result: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new HttpError(502, '登录服务响应格式不正确');
      return result as Record<string, unknown>;
    })()]);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, '登录服务暂不可用，请稍后重试');
  } finally {
    clearTimeout(timer);
    controller.abort();
    void reader?.cancel().catch(() => {});
  }
}
