import { describe, expect, it, vi } from 'vitest';
import { MatrixClient } from '../src/matrix';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('MatrixClient', () => {
  it('logs in as the current ChurchTools Matrix user and sends into an existing direct room', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ access_token: 'temporary-token', user_id: '@ct_me:chat.church.tools' }))
      .mockResolvedValueOnce(response({ '@ct_recipient:chat.church.tools': ['!existing:chat.church.tools'] }))
      .mockResolvedValueOnce(response({ event_id: '$event' }));
    const client = new MatrixClient('https://chat.church.tools', '@ct_me:chat.church.tools', fetcher);

    await client.login('personal-secret');
    await client.sendText('@ct_recipient:chat.church.tools', 'Hallo!');

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      identifier: { user: '@ct_me:chat.church.tools' },
      password: 'personal-secret'
    });
    expect(fetcher.mock.calls[2]?.[0]).toContain('/rooms/!existing%3Achat.church.tools/send/m.room.message/');
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toEqual({ msgtype: 'm.text', body: 'Hallo!' });
  });

  it('creates and records a private direct room when none exists', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ access_token: 'temporary-token', user_id: '@ct_me:chat.church.tools' }))
      .mockResolvedValueOnce(response({}, 404))
      .mockResolvedValueOnce(response({ room_id: '!new:chat.church.tools' }))
      .mockResolvedValueOnce(response({}))
      .mockResolvedValueOnce(response({ event_id: '$event' }));
    const client = new MatrixClient('https://chat.church.tools', '@ct_me:chat.church.tools', fetcher);

    await client.login('personal-secret');
    await client.sendText('@ct_recipient:chat.church.tools', 'Persönlich');

    const createCall = fetcher.mock.calls.find(call => String(call[0]).endsWith('/createRoom'));
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({
      is_direct: true,
      preset: 'private_chat',
      visibility: 'private',
      invite: ['@ct_recipient:chat.church.tools']
    });
    const accountDataCall = fetcher.mock.calls.find(call => String(call[0]).includes('/account_data/m.direct'));
    expect(accountDataCall).toBeDefined();
  });

  it('binds the native fetch context when no custom fetcher is supplied', async () => {
    const browserFetch = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      return Promise.resolve(response({ access_token: 'temporary-token', user_id: '@ct_me:chat.church.tools' }));
    });
    vi.stubGlobal('fetch', browserFetch);

    try {
      const client = new MatrixClient('https://chat.church.tools', '@ct_me:chat.church.tools');
      await client.login('personal-secret');
      expect(client.connected).toBe(true);
      expect(browserFetch).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
