import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { APIContext } from 'astro';
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { readerConfig } from '../src/config/readers';
import { siteConfig } from '../src/config/site';
import { getDatabase } from '../src/lib/db';
import { createPasskeyLoginOptions, createPasskeyRegistrationOptions, deleteReaderPasskey, verifyPasskeyLogin, verifyPasskeyRegistration } from '../src/lib/reader-passkeys';
import { listReaderPasskeys, readReaderSession, readerCookieName, readerPasskeyCookieName, resolveReaderIdentity, startReaderSession, type ReaderCookies } from '../src/lib/readers';
import { POST as registrationOptionsRoute } from '../src/pages/api/reader/passkeys/register-options.json';
import { POST as loginVerifyRoute } from '../src/pages/api/reader/passkeys/login-verify.json';

beforeAll(async () => { vi.stubEnv('BLOG_DATA_DIR', await mkdtemp(join(tmpdir(), 'samsblog-passkeys-'))); });
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  getDatabase().exec('DELETE FROM reader_sessions; DELETE FROM reader_passkey_challenges; DELETE FROM reader_passkeys; DELETE FROM reader_identities; DELETE FROM reader_auth_limits; DELETE FROM readers;');
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function cookieJar() {
  const values = new Map<string, string>();
  const cookies = { get: (name: string) => values.has(name) ? { value: values.get(name)! } : undefined,
    set: vi.fn((name: string, value: string) => { values.set(name, value); }), delete: vi.fn((name: string) => { values.delete(name); }),
  } as unknown as ReaderCookies;
  return { cookies, values };
}

function signedIn(subject = 'fixture') {
  const jar = cookieJar();
  const reader = resolveReaderIdentity('email', subject, '测试读者', null);
  startReaderSession(jar.cookies, reader, 'email');
  return { ...jar, reader };
}

// 最小测试认证器输出真实 P-256 公钥、CBOR attestation 和 DER 签名，不替换验证库。
function cbor(value: string | Buffer | Map<string, unknown>): Buffer {
  if (value instanceof Map) return Buffer.concat([Buffer.from([0xa0 + value.size]), ...[...value].flatMap(([key, item]) => [cbor(key), cbor(item as string | Buffer | Map<string, unknown>)])]);
  const bytes = typeof value === 'string' ? Buffer.from(value) : value;
  const major = typeof value === 'string' ? 0x60 : 0x40;
  const prefix = bytes.length < 24 ? Buffer.from([major + bytes.length]) : bytes.length < 256 ? Buffer.from([major + 24, bytes.length]) : Buffer.from([major + 25, bytes.length >> 8, bytes.length & 255]);
  return Buffer.concat([prefix, bytes]);
}

function authenticator() {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKey = keys.publicKey.export({ format: 'jwk' });
  const cose = Buffer.concat([Buffer.from('a5010203262001215820', 'hex'), Buffer.from(publicKey.x!, 'base64url'), Buffer.from('225820', 'hex'), Buffer.from(publicKey.y!, 'base64url')]);
  const credential = randomBytes(32);
  const id = credential.toString('base64url');
  const rpHash = createHash('sha256').update(new URL(siteConfig.siteUrl).hostname).digest();
  const clientData = (type: string, challenge: string, origin = new URL(siteConfig.siteUrl).origin) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    id,
    register(challenge: string, origin?: string, flags = 0x45) {
      const data = clientData('webauthn.create', challenge, origin);
      const authData = Buffer.concat([rpHash, Buffer.from([flags]), Buffer.alloc(4), Buffer.alloc(16), Buffer.from([0, credential.length]), credential, cose]);
      const attestationObject = cbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
      return { id, rawId: id, type: 'public-key', clientExtensionResults: { credProps: { rk: true } }, authenticatorAttachment: 'platform',
        response: { clientDataJSON: data.toString('base64url'), attestationObject: attestationObject.toString('base64url'), transports: ['internal'] } };
    },
    login(challenge: string, userHandle: string, counter = 1, options: { origin?: string; flags?: number; invalidSignature?: boolean } = {}) {
      const data = clientData('webauthn.get', challenge, options.origin);
      const count = Buffer.alloc(4); count.writeUInt32BE(counter);
      const authData = Buffer.concat([rpHash, Buffer.from([options.flags ?? 0x05]), count]);
      const signature = sign('sha256', Buffer.concat([authData, createHash('sha256').update(data).digest()]), keys.privateKey);
      if (options.invalidSignature) signature[signature.length - 1] ^= 1;
      return { id, rawId: id, type: 'public-key', clientExtensionResults: {}, authenticatorAttachment: 'platform', response: {
        clientDataJSON: data.toString('base64url'), authenticatorData: authData.toString('base64url'), signature: signature.toString('base64url'), userHandle,
      } };
    },
  };
}

async function registered(subject = 'fixture') {
  const account = signedIn(subject);
  const device = authenticator();
  const options = await createPasskeyRegistrationOptions(account.cookies);
  const passkeys = await verifyPasskeyRegistration(account.cookies, { label: '测试设备', response: device.register(options.challenge) });
  return { ...account, device, passkeys, userHandle: options.user.id };
}

describe('passkey registration and account boundaries', () => {
  it('registers a real attestation and exposes only friendly metadata', async () => {
    const account = await registered();
    expect(account.passkeys).toEqual([{ id: expect.any(Number), label: '测试设备', createdAt: expect.any(String), lastUsedAt: null }]);
    const stored = getDatabase().prepare('SELECT credential_id,public_key,counter,transports FROM reader_passkeys').get() as { credential_id: string; public_key: Buffer; counter: number; transports: string };
    expect(stored.credential_id).toBe(account.device.id);
    expect(stored.public_key).toBeInstanceOf(Buffer);
    expect(stored.counter).toBe(0);
    expect(JSON.parse(stored.transports)).toEqual(['internal']);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires a recent session and rejects expired registration challenges', async () => {
    await expect(createPasskeyRegistrationOptions(cookieJar().cookies)).rejects.toMatchObject({ status: 401, code: 'reauth_required' });
    const account = signedIn();
    getDatabase().prepare('UPDATE reader_sessions SET created_at=?').run(Date.now() - readerConfig.recentAuthenticationSeconds * 1000);
    await expect(createPasskeyRegistrationOptions(account.cookies)).rejects.toMatchObject({ status: 401, code: 'reauth_required' });
    startReaderSession(account.cookies, account.reader, 'email');
    const options = await createPasskeyRegistrationOptions(account.cookies);
    getDatabase().prepare('UPDATE reader_passkey_challenges SET expires_at=?').run(Date.now());
    await expect(verifyPasskeyRegistration(account.cookies, { label: '设备', response: authenticator().register(options.challenge) })).rejects.toMatchObject({ status: 400 });
  });

  it('binds registration to the initiating session and consumes failed proofs once', async () => {
    const account = signedIn();
    const device = authenticator();
    const options = await createPasskeyRegistrationOptions(account.cookies);
    startReaderSession(account.cookies, account.reader, 'email');
    await expect(verifyPasskeyRegistration(account.cookies, { label: '设备', response: device.register(options.challenge) })).rejects.toMatchObject({ status: 400 });
    expect(listReaderPasskeys(account.reader.id)).toEqual([]);
    const next = await createPasskeyRegistrationOptions(account.cookies);
    await expect(verifyPasskeyRegistration(account.cookies, { label: '设备', response: device.register(next.challenge, 'https://attacker.example') })).rejects.toMatchObject({ status: 400 });
    await expect(verifyPasskeyRegistration(account.cookies, { label: '设备', response: device.register(next.challenge) })).rejects.toMatchObject({ status: 400 });
  });

  it('requires UV during registration and enforces ownership on deletion', async () => {
    const account = signedIn();
    const device = authenticator();
    const options = await createPasskeyRegistrationOptions(account.cookies);
    expect(options.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' });
    await expect(verifyPasskeyRegistration(account.cookies, { label: '设备', response: device.register(options.challenge, undefined, 0x41) })).rejects.toMatchObject({ status: 400 });
    const owner = await registered('owner');
    expect(() => deleteReaderPasskey(account.cookies, owner.passkeys[0]!.id)).toThrow('通行密钥不存在');
    expect(listReaderPasskeys(owner.reader.id)).toHaveLength(1);
  });
});

describe('passkey authentication proofs', () => {
  it('verifies a real signature, updates the counter, rotates the session and rejects replay', async () => {
    const account = await registered();
    const oldSession = account.values.get(readerCookieName);
    const options = await createPasskeyLoginOptions(account.cookies);
    expect(options.allowCredentials).toEqual([]);
    expect(options.userVerification).toBe('required');
    const proof = { response: account.device.login(options.challenge, account.userHandle) };
    const reader = await verifyPasskeyLogin(account.cookies, proof);
    expect(reader.id).toBe(account.reader.id);
    expect(reader.loginMethod).toBe('passkey');
    expect(account.values.get(readerCookieName)).not.toBe(oldSession);
    expect(getDatabase().prepare('SELECT counter FROM reader_passkeys').get()).toEqual({ counter: 1 });
    expect(listReaderPasskeys(reader.id)[0]!.lastUsedAt).not.toBeNull();
    await expect(verifyPasskeyLogin(account.cookies, proof)).rejects.toMatchObject({ status: 400 });
    const next = await createPasskeyLoginOptions(account.cookies);
    await expect(verifyPasskeyLogin(account.cookies, { response: account.device.login(next.challenge, account.userHandle, 1) })).rejects.toMatchObject({ status: 400 });
  });

  it.each(['signature', 'origin', 'userHandle', 'userVerification', 'challenge'])('rejects an invalid %s without creating a session', async (invalid) => {
    const account = await registered();
    const browser = cookieJar();
    const options = await createPasskeyLoginOptions(browser.cookies);
    const proof = account.device.login(invalid === 'challenge' ? 'wrong-challenge' : options.challenge,
      invalid === 'userHandle' ? 'wrong-reader' : account.userHandle, 1,
      { invalidSignature: invalid === 'signature', origin: invalid === 'origin' ? 'https://attacker.example' : undefined, flags: invalid === 'userVerification' ? 0x01 : undefined });
    await expect(verifyPasskeyLogin(browser.cookies, { response: proof })).rejects.toMatchObject({ status: 400 });
    expect(readReaderSession(browser.cookies)).toBeNull();
    expect(getDatabase().prepare('SELECT counter FROM reader_passkeys').get()).toEqual({ counter: 0 });
    expect(browser.values.has(readerPasskeyCookieName)).toBe(false);
  });

  it('soft-deletes only the owned key and revokes its previously issued sessions', async () => {
    const account = await registered();
    const browser = cookieJar();
    const options = await createPasskeyLoginOptions(browser.cookies);
    await verifyPasskeyLogin(browser.cookies, { response: account.device.login(options.challenge, account.userHandle) });
    expect(deleteReaderPasskey(account.cookies, account.passkeys[0]!.id)).toEqual([]);
    expect(readReaderSession(browser.cookies)).toBeNull();
    expect(readReaderSession(account.cookies)?.loginMethod).toBe('email');
    const next = await createPasskeyLoginOptions(browser.cookies);
    await expect(verifyPasskeyLogin(browser.cookies, { response: account.device.login(next.challenge, account.userHandle, 2) })).rejects.toMatchObject({ status: 400 });
  });

  it('returns reauthentication codes and rejects foreign origins and oversized JSON at the API boundary', async () => {
    const account = signedIn();
    const context = (body: unknown, requestOrigin = new URL(siteConfig.siteUrl).origin) => ({ cookies: account.cookies, clientAddress: '198.51.100.8',
      request: new Request(new URL('/api/reader/passkeys/register-options.json', siteConfig.siteUrl), { method: 'POST', headers: { origin: requestOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    }) as APIContext;
    getDatabase().prepare('UPDATE reader_sessions SET created_at=0').run();
    const stale = await registrationOptionsRoute(context({}));
    expect(stale.status).toBe(401);
    expect(await stale.json()).toMatchObject({ code: 'reauth_required' });
    expect((await registrationOptionsRoute(context({}, 'https://attacker.example'))).status).toBe(403);
    expect((await loginVerifyRoute(context({ response: 'x'.repeat(readerConfig.passkeyRequestMaximumBytes) }))).status).toBe(413);
  });
});
