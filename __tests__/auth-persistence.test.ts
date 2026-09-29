/**
 * Token-based authentication verification suite.
 *
 *   npx jest __tests__/auth-persistence.test.ts
 *
 * What this proves: the real src/services/api.client.ts refresh state machine
 * and the real AuthContext startup bootstrap, driven against the exact backend
 * contract (POST /api/auth/refresh reads `refreshToken` from the JSON body and
 * answers { success, accessToken, refreshToken }). It also asserts that no
 * request carries a Cookie header and that no credential is read from
 * Set-Cookie.
 *
 * What it cannot prove: on-device behaviour (real AsyncStorage, the OS process
 * lifecycle, the native cookie jar). Restart is simulated by seeding the mocked
 * storage and mounting a fresh provider.
 */

import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import type { ReactTestRenderer as RendererTree } from 'react-test-renderer';
// Static imports: jest.resetModules() would hand each re-required module a
// second copy of React, which breaks the renderer's dispatcher.
import * as apiClient from '../src/services/api.client';
import * as authContextModule from '../src/context/AuthContext';
import * as authModule from '../src/services/auth.service';
import { Env } from '../src/config/env';

/* ── Mocked storage (stands in for AsyncStorage) ─────────────────────── */

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  const asKey = (k: unknown) => String(k);
  return {
    __esModule: true,
    default: {
      __store: store,
      setItem: jest.fn(async (k: string, v: string) => {
        store.set(asKey(k), String(v));
      }),
      getItem: jest.fn(async (k: string) => {
        const v = store.get(asKey(k));
        return v === undefined ? null : v;
      }),
      removeItem: jest.fn(async (k: string) => {
        store.delete(asKey(k));
      }),
    },
  };
});

/* react-query is only touched to clear its cache on sign-out. */
const mockQueryClear = jest.fn();
jest.mock('../src/services/queryClient', () => ({
  queryClient: { clear: () => mockQueryClear() },
}));

/* Shorten the auth deadline so the timeout path is exercised with real
 * timers (fake timers deadlock React's async act flush). */
jest.mock('../src/config/env', () => ({
  Env: {
    API_BASE_URL: 'http://192.168.0.108:3000',
    API_TIMEOUT: 25,
  },
}));

const ACCESS_KEY = '@sajjanmart:accessToken';
const REFRESH_KEY = '@sajjanmart:refreshToken';
const USER_KEY = '@sajjanmart:user';
const NAV_KEY = '@sajjanmart:navigation';

function storage(): Map<string, string> {
  return jest.requireMock('@react-native-async-storage/async-storage').default
    .__store as Map<string, string>;
}

/* ── Fetch recorder ──────────────────────────────────────────────────── */

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

let calls: Call[] = [];

function headerValue(call: Call, name: string): string | undefined {
  const key = Object.keys(call.headers).find(
    k => k.toLowerCase() === name.toLowerCase(),
  );
  return key ? call.headers[key] : undefined;
}

function recordCall(url: string, init?: RequestInit): Call {
  const call: Call = {
    url: String(url),
    method: (init?.method ?? 'GET').toUpperCase(),
    headers: Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    ),
    body: init?.body == null ? undefined : String(init.body),
  };
  calls.push(call);
  return call;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function refreshCalls(): Call[] {
  return calls.filter(c => c.url.includes('/api/auth/refresh'));
}

/** The backend route reads refreshToken from the JSON body. */
function refreshTokenFromBody(call: Call): unknown {
  if (!call.body) return undefined;
  return (JSON.parse(call.body) as { refreshToken?: unknown }).refreshToken;
}

async function withAuthTokens(accessToken: string | null) {
  if (accessToken) storage().set(ACCESS_KEY, accessToken);
  else storage().delete(ACCESS_KEY);
  storage().set(REFRESH_KEY, 'stored-refresh-token');
  storage().set(
    USER_KEY,
    JSON.stringify({ id: 'u1', username: 'store@sajjan.in', role: 'staff' }),
  );
}

/* ── Suite ───────────────────────────────────────────────────────────── */

beforeEach(() => {
  jest.useRealTimers();
  storage().clear();
  calls = [];
  mockQueryClear.mockClear();
  globalThis.fetch = jest.fn() as unknown as typeof fetch;
  // Drop any auth-expired listener a previous test registered on the
  // module-level singleton.
  const dispose = apiClient.onAuthExpired(() => {});
  dispose();
});

/**
 * Drain the bootstrap promise chain, landing every state update inside act()
 * so React does not warn about updates outside a test boundary. Each round
 * yields a real macrotask, so chains that hop through async storage mocks or
 * abort listeners fully settle. (Callers must be back on real timers.)
 */
async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    });
  }
}

/* ──────────────────────────────────────────────────────────────────────
 * Proofs 1 + 2 + 3 — the refresh transport is the JSON body, never a cookie.
 * ────────────────────────────────────────────────────────────────────── */
describe('token-based refresh transport', () => {
  it('sends the stored refresh token in the JSON body and no Cookie header', async () => {
    await withAuthTokens('expired-access-token');
    const api = apiClient;

    (globalThis.fetch as jest.Mock).mockImplementation(
      async (url: string, init?: RequestInit) => {
        recordCall(url, init);
        if (String(url).includes('/api/auth/refresh')) {
          return jsonResponse({
            success: true,
            accessToken: 'brand-new-access-token',
            refreshToken: 'rotated-refresh-token',
          });
        }
        // The retried call also 401s — this test inspects only the transport.
        return jsonResponse({ error: 'Unauthorized' }, 401);
      },
    );

    await expect(api.apiGet('/api/orders')).rejects.toBeTruthy();

    const refresh = refreshCalls();
    expect(refresh).toHaveLength(1);
    expect(refreshTokenFromBody(refresh[0])).toBe('stored-refresh-token');
    // Proof 2: no cookie transport anywhere.
    expect(headerValue(refresh[0], 'Cookie')).toBeUndefined();
    expect(headerValue(refresh[0], 'Content-Type')).toBe('application/json');
    expect(calls.every(c => headerValue(c, 'Cookie') === undefined)).toBe(true);

    // Proof 3: both tokens from the JSON body are persisted.
    expect(storage().get(ACCESS_KEY)).toBe('brand-new-access-token');
    expect(storage().get(REFRESH_KEY)).toBe('rotated-refresh-token');
  });

  it('ignores Set-Cookie and keeps the stored token when the body has no rotation', async () => {
    await withAuthTokens('expired-access-token');
    const api = apiClient;

    (globalThis.fetch as jest.Mock).mockImplementation(
      async (url: string, init?: RequestInit) => {
        recordCall(url, init);
        if (String(url).includes('/api/auth/refresh')) {
          // Backend rotates only the access token and sets a cookie. The body
          // must be the only source of truth.
          return jsonResponse(
            { success: true, accessToken: 'brand-new-access-token' },
            200,
            { 'set-cookie': 'refresh_token=cookie-token; Path=/; HttpOnly' },
          );
        }
        return jsonResponse({ error: 'Unauthorized' }, 401);
      },
    );

    await expect(api.apiGet('/api/orders')).rejects.toBeTruthy();

    expect(storage().get(ACCESS_KEY)).toBe('brand-new-access-token');
    // A valid stored refresh token is never replaced by a cookie value or by
    // an absent body field.
    expect(storage().get(REFRESH_KEY)).toBe('stored-refresh-token');
  });

  it('login and signup take both tokens from the JSON body', async () => {
    const auth = authModule;

    (globalThis.fetch as jest.Mock).mockImplementation(
      async (url: string, init?: RequestInit) => {
        recordCall(url, init);
        return jsonResponse(
          {
            accessToken: 'access-from-body',
            refreshToken: 'refresh-from-body',
            user: { id: 'u1', email: 'store@sajjan.in', name: 'Store', role: 'staff' },
          },
          200,
          // A cookie is set for the web client; it must be ignored.
          { 'set-cookie': 'refresh_token=cookie-refresh; Path=/; HttpOnly' },
        );
      },
    );

    const result = await auth.login('store@sajjan.in', 'password');

    expect(result.accessToken).toBe('access-from-body');
    expect(result.refreshToken).toBe('refresh-from-body');
    expect(storage().get(ACCESS_KEY)).toBe('access-from-body');
    expect(storage().get(REFRESH_KEY)).toBe('refresh-from-body');

    const login = calls.find(c => c.url.includes('/api/auth/login'));
    expect(login?.body).toContain('store@sajjan.in');
    expect(headerValue(login as Call, 'Cookie')).toBeUndefined();
    expect(headerValue(login as Call, 'Authorization')).toBeUndefined();
  });
});

/* ──────────────────────────────────────────────────────────────────────
 * Proofs 6 + 7 — concurrent 401s share one refresh, originals retry once.
 * ────────────────────────────────────────────────────────────────────── */
describe('centralized auto-refresh', () => {
  it('refreshes on 401 and retries the original request with the new token', async () => {
    await withAuthTokens('expired-access-token');
    const api = apiClient;

    let orderRequests = 0;
    (globalThis.fetch as jest.Mock).mockImplementation(async (url: string, init?: RequestInit) => {
      recordCall(url, init);
      if (String(url).includes('/api/orders')) {
        orderRequests++;
        const sent = (init?.headers as Record<string, string>).Authorization;
        return sent === 'Bearer brand-new-access-token'
          ? jsonResponse({ success: true, data: [] })
          : jsonResponse({ error: 'Unauthorized' }, 401);
      }
      // Real backend shape: { success, accessToken, refreshToken }
      return jsonResponse({
        success: true,
        accessToken: 'brand-new-access-token',
        refreshToken: 'rotated-refresh-token',
      });
    });

    const data = await api.apiGet<{ success: boolean }>('/api/orders');

    expect(data).toEqual({ success: true, data: [] });
    expect(orderRequests).toBe(2); // original + one retry
    const refresh = refreshCalls();
    expect(refresh).toHaveLength(1);
    expect(refreshTokenFromBody(refresh[0])).toBe('stored-refresh-token');
    // Rotated refresh token is persisted, so the session survives the next expiry
    expect(storage().get(REFRESH_KEY)).toBe('rotated-refresh-token');
    expect(storage().get(ACCESS_KEY)).toBe('brand-new-access-token');
  });

  it('shares ONE refresh across simultaneous 401s', async () => {
    await withAuthTokens('expired-access-token');
    const api = apiClient;

    const retried = { count: 0 };
    (globalThis.fetch as jest.Mock).mockImplementation(async (url: string, init?: RequestInit) => {
      recordCall(url, init);
      if (String(url).includes('/api/auth/refresh')) {
        await new Promise<void>(r => setTimeout(r, 20));
        return jsonResponse({ success: true, accessToken: 'fresh-token' });
      }
      const sent = (init?.headers as Record<string, string>).Authorization;
      if (sent === 'Bearer fresh-token') {
        retried.count++;
        return jsonResponse({ success: true, data: sent });
      }
      return jsonResponse({ error: 'Unauthorized' }, 401);
    });

    const results = await Promise.all([
      api.apiGet<{ success: boolean }>('/api/orders'),
      api.apiGet<{ success: boolean }>('/api/profile'),
      api.apiPost<{ success: boolean }>('/api/orders/sync', { a: 1 }),
    ]);

    expect(refreshCalls()).toHaveLength(1);
    expect(retried.count).toBe(3);
    expect(results.every(r => r.success)).toBe(true);
  });

  it('never retries twice — a 401 after a successful refresh stops the loop', async () => {
    await withAuthTokens('expired-access-token');
    const api = apiClient;

    (globalThis.fetch as jest.Mock).mockImplementation(async (url: string, init?: RequestInit) => {
      recordCall(url, init);
      if (String(url).includes('/api/auth/refresh')) {
        return jsonResponse({ success: true, accessToken: 'fresh-token' });
      }
      return jsonResponse({ error: 'Unauthorized' }, 401);
    });

    await expect(api.apiGet('/api/orders')).rejects.toMatchObject({ status: 401 });
    expect(refreshCalls()).toHaveLength(1);
    // Access token remains: the session itself was never declared invalid
    expect(storage().get(ACCESS_KEY)).toBe('fresh-token');
  });
});

/* ──────────────────────────────────────────────────────────────────────
 * Proofs 4 + 5 — only a server-confirmed rejection may clear credentials.
 * ────────────────────────────────────────────────────────────────────── */
describe('invalidation vs transient failure', () => {
  it('an expired/invalid refresh token clears the session and notifies once', async () => {
    await withAuthTokens('expired-access-token');
    const api = apiClient;

    let expiredNotifications = 0;
    api.onAuthExpired(() => {
      expiredNotifications++;
    });

    (globalThis.fetch as jest.Mock).mockImplementation(async (url: string, init?: RequestInit) => {
      recordCall(url, init);
      if (String(url).includes('/api/auth/refresh')) {
        return jsonResponse({ error: 'Invalid refresh token' }, 401);
      }
      return jsonResponse({ error: 'Unauthorized' }, 401);
    });

    await expect(api.apiGet('/api/orders')).rejects.toBeTruthy();

    expect(storage().has(ACCESS_KEY)).toBe(false);
    expect(storage().has(REFRESH_KEY)).toBe(false);
    expect(storage().has(USER_KEY)).toBe(false);
    expect(expiredNotifications).toBe(1);
    expect(refreshCalls()).toHaveLength(1);
  });

  it('a deactivated account (403 from refresh) ends the session', async () => {
    await withAuthTokens('expired-access-token');
    const api = apiClient;

    let expiredNotifications = 0;
    api.onAuthExpired(() => {
      expiredNotifications++;
    });

    (globalThis.fetch as jest.Mock).mockImplementation(
      async (url: string, init?: RequestInit) => {
        recordCall(url, init);
        if (String(url).includes('/api/auth/refresh')) {
          return jsonResponse({ error: 'Account deactivated' }, 403);
        }
        return jsonResponse({ error: 'Unauthorized' }, 401);
      },
    );

    await expect(api.apiGet('/api/orders')).rejects.toMatchObject({ status: 403 });

    expect(expiredNotifications).toBe(1);
    expect(storage().has(REFRESH_KEY)).toBe(false);
    expect(storage().has(ACCESS_KEY)).toBe(false);
  });

  it('offline during a request does NOT sign the user out', async () => {
    await withAuthTokens('expired-access-token');
    const api = apiClient;

    let expiredNotifications = 0;
    api.onAuthExpired(() => {
      expiredNotifications++;
    });

    (globalThis.fetch as jest.Mock).mockImplementation(async (url: string, init?: RequestInit) => {
      recordCall(url, init);
      if (String(url).includes('/api/auth/refresh')) {
        // Device has no route to the backend at all.
        throw new TypeError('Network request failed');
      }
      return jsonResponse({ error: 'Unauthorized' }, 401);
    });

    await expect(api.apiGet('/api/orders')).rejects.toBeTruthy();

    expect(refreshCalls()).toHaveLength(1);
    expect(expiredNotifications).toBe(0);
    expect(storage().get(REFRESH_KEY)).toBe('stored-refresh-token');
    expect(storage().get(ACCESS_KEY)).toBe('expired-access-token');
  });

  it('a 503 from the refresh endpoint (cold start) keeps the session', async () => {
    await withAuthTokens('expired-access-token');
    const api = apiClient;

    let expiredNotifications = 0;
    api.onAuthExpired(() => expiredNotifications++);

    (globalThis.fetch as jest.Mock).mockImplementation(async (url: string, init?: RequestInit) => {
      recordCall(url, init);
      if (String(url).includes('/api/auth/refresh')) {
        return jsonResponse({ error: 'Starting up' }, 503);
      }
      return jsonResponse({ error: 'Unauthorized' }, 401);
    });

    await expect(api.apiGet('/api/orders')).rejects.toBeTruthy();
    expect(expiredNotifications).toBe(0);
    expect(storage().has(REFRESH_KEY)).toBe(true);
  });

  it('a gateway HTML error page keeps the session and the status code', async () => {
    await withAuthTokens('expired-access-token');
    const api = apiClient;

    let expiredNotifications = 0;
    api.onAuthExpired(() => expiredNotifications++);

    (globalThis.fetch as jest.Mock).mockImplementation(
      async (url: string, init?: RequestInit) => {
        recordCall(url, init);
        return {
          ok: false,
          status: 502,
          headers: { get: () => null },
          text: async () => '<html><head>502 Bad Gateway</head></body>',
          json: async () => {
            throw new SyntaxError('Unexpected token <');
          },
        } as unknown as Response;
      },
    );

    await expect(api.apiGet('/api/orders')).rejects.toMatchObject({ status: 502 });
    expect(expiredNotifications).toBe(0);
    expect(storage().has(REFRESH_KEY)).toBe(true);
  });

  it('a 401 that arrives as an HTML page still triggers the refresh', async () => {
    await withAuthTokens('expired-access-token');
    const api = apiClient;

    (globalThis.fetch as jest.Mock).mockImplementation(
      async (url: string, init?: RequestInit) => {
        recordCall(url, init);
        if (String(url).includes('/api/auth/refresh')) {
          return jsonResponse({ success: true, accessToken: 'fresh-token' });
        }
        return {
          ok: false,
          status: 401,
          headers: { get: () => null },
          text: async () => '<html>unauthorized</html>',
          json: async () => {
            throw new SyntaxError('Unexpected token <');
          },
        } as unknown as Response;
      },
    );

    await expect(api.apiGet('/api/orders')).rejects.toMatchObject({ status: 401 });
    expect(refreshCalls()).toHaveLength(1);
    // Refreshed successfully, so the session must survive the failing call
    expect(storage().get(ACCESS_KEY)).toBe('fresh-token');
    expect(storage().has(REFRESH_KEY)).toBe(true);
  });

  it('a hung refresh is aborted on a deadline instead of blocking every later 401', async () => {
    await withAuthTokens('expired-access-token');
    const api = apiClient;

    let expiredNotifications = 0;
    api.onAuthExpired(() => expiredNotifications++);

    (globalThis.fetch as jest.Mock).mockImplementation(
      (url: string, init?: RequestInit) => {
        recordCall(url, init);
        if (String(url).includes('/api/auth/refresh')) {
          // Never resolves on its own — only the abort settles it.
          return new Promise<never>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new Error('aborted')),
            );
          });
        }
        return Promise.resolve(jsonResponse({ error: 'Unauthorized' }, 401));
      },
    );

    const pending = api.apiGet('/api/orders').catch(e => e);

    await expect(pending).resolves.toMatchObject({ status: 0 });
    expect(expiredNotifications).toBe(0);
    expect(storage().has(REFRESH_KEY)).toBe(true);
  });
});

/* ──────────────────────────────────────────────────────────────────────
 * Explicit logout wipes everything authentication-related.
 * ────────────────────────────────────────────────────────────────────── */
describe('explicit logout', () => {
  it('signOut clears both tokens, the cached user, navigation state and cache', async () => {
    await withAuthTokens('valid-access-token');
    storage().set(NAV_KEY, JSON.stringify([{ screen: 'orders', orderId: null }]));

    const { AuthProvider, useAuth } = authContextModule;

    let captured: { signOut: (cb?: () => void) => Promise<void> } | null = null;
    function Probe() {
      const auth = useAuth();
      captured = auth;
      return null;
    }

    (globalThis.fetch as jest.Mock).mockImplementation(async (url: string, init?: RequestInit) => {
      recordCall(url, init);
      return jsonResponse({ user: { id: 'u1', email: 'store@sajjan.in', name: 'Store', role: 'staff' } });
    });

    let tree!: RendererTree;
    await act(async () => {
      tree = ReactTestRenderer.create(
        React.createElement(AuthProvider, null, React.createElement(Probe)),
      );
    });

    expect(captured).not.toBeNull();
    await act(async () => {
      await (captured as NonNullable<typeof captured>).signOut();
    });

    expect(storage().has(ACCESS_KEY)).toBe(false);
    expect(storage().has(REFRESH_KEY)).toBe(false);
    expect(storage().has(USER_KEY)).toBe(false);
    expect(storage().has(NAV_KEY)).toBe(false);
    expect(mockQueryClear).toHaveBeenCalledTimes(1);
    await act(async () => {
      tree.unmount();
    });
  });

  it('auth.service.logout() revokes server-side before wiping local state', async () => {
    await withAuthTokens('valid-access-token');
    const auth = authModule;

    (globalThis.fetch as jest.Mock).mockImplementation(async (url: string, init?: RequestInit) => {
      recordCall(url, init);
      return jsonResponse({ success: true });
    });

    await auth.logout();

    const logoutCall = calls.find(c => c.url.includes('/api/auth/logout'));
    expect(logoutCall?.method).toBe('POST');
    expect(refreshTokenFromBody(logoutCall as Call)).toBe('stored-refresh-token');
    expect(headerValue(logoutCall as Call, 'Cookie')).toBeUndefined();
    expect(storage().has(ACCESS_KEY)).toBe(false);
    expect(storage().has(REFRESH_KEY)).toBe(false);
  });
});

/* ──────────────────────────────────────────────────────────────────────
 * Proof 8 — a fresh JS context (as after a force-close or a device restart)
 * restores the session from persisted storage without ever reporting "not
 * authenticated" to the UI.
 * ────────────────────────────────────────────────────────────────────── */
describe('session restore on a cold start', () => {
  function observeAuth() {
    const { AuthProvider, useAuth } = authContextModule;
    const snapshots: Array<{
      isInitialized: boolean;
      isAuthenticated: boolean;
      user: unknown;
    }> = [];
    function Probe() {
      const auth = useAuth();
      snapshots.push({
        isInitialized: auth.isInitialized,
        isAuthenticated: auth.isAuthenticated,
        user: auth.user,
      });
      return null;
    }
    return { AuthProvider, Probe, snapshots };
  }

  async function boot() {
    const { AuthProvider, Probe, snapshots } = observeAuth();
    let tree!: RendererTree;
    await act(async () => {
      tree = ReactTestRenderer.create(
        React.createElement(AuthProvider, null, React.createElement(Probe)),
      );
    });
    await settle();
    return { tree, snapshots };
  }

  it('expired access token → refresh → dashboard session, login never shown', async () => {
    // Persisted exactly as a previous run left it: expired access, live refresh.
    storage().set(ACCESS_KEY, 'expired-access-token');
    storage().set(REFRESH_KEY, 'stored-refresh-token');
    storage().set(
      USER_KEY,
      JSON.stringify({ id: 'u1', username: 'store@sajjan.in', role: 'staff' }),
    );

    (globalThis.fetch as jest.Mock).mockImplementation(async (url: string, init?: RequestInit) => {
      recordCall(url, init);
      if (String(url).includes('/api/auth/refresh')) {
        return jsonResponse({ success: true, accessToken: 'brand-new-access-token' });
      }
      const sent = ((init?.headers ?? {}) as Record<string, string>).Authorization;
      if (String(url).includes('/api/auth/me') && sent === 'Bearer brand-new-access-token') {
        return jsonResponse({
          user: { id: 'u1', email: 'store@sajjan.in', name: 'Store', role: 'staff' },
        });
      }
      return jsonResponse({ user: null }, 401);
    });

    const { tree, snapshots } = await boot();

    // While undecided the provider reports isInitialized=false, which is what
    // keeps App.tsx on the splash instead of flashing LoginScreen.
    expect(snapshots[0]).toEqual({
      isInitialized: false,
      isAuthenticated: false,
      user: null,
    });
    const last = snapshots[snapshots.length - 1];
    expect(last.isInitialized).toBe(true);
    expect(last.isAuthenticated).toBe(true);
    expect(last.user).toMatchObject({ id: 'u1' });
    expect(refreshCalls()).toHaveLength(1);
    expect(storage().get(ACCESS_KEY)).toBe('brand-new-access-token');
    await act(async () => {
      tree.unmount();
    });
  });

  it('a session holding ONLY the refresh token is still restorable', async () => {
    storage().set(REFRESH_KEY, 'stored-refresh-token');
    storage().set(
      USER_KEY,
      JSON.stringify({ id: 'u1', username: 'store@sajjan.in', role: 'staff' }),
    );

    (globalThis.fetch as jest.Mock).mockImplementation(async (url: string, init?: RequestInit) => {
      recordCall(url, init);
      if (String(url).includes('/api/auth/refresh')) {
        return jsonResponse({ success: true, accessToken: 'brand-new-access-token' });
      }
      const sent = ((init?.headers ?? {}) as Record<string, string>).Authorization;
      if (sent === 'Bearer brand-new-access-token') {
        return jsonResponse({
          user: { id: 'u1', email: 'store@sajjan.in', name: 'Store', role: 'staff' },
        });
      }
      return jsonResponse({ user: null }, 401);
    });

    const { tree, snapshots } = await boot();
    const last = snapshots[snapshots.length - 1];
    expect(last.isAuthenticated).toBe(true);
    await act(async () => {
      tree.unmount();
    });
  });

  it('offline at startup keeps the cached session (no forced login)', async () => {
    await withAuthTokens('still-valid-access-token');

    (globalThis.fetch as jest.Mock).mockImplementation(async (url: string, init?: RequestInit) => {
      recordCall(url, init);
      throw new TypeError('Network request failed');
    });

    const { tree, snapshots } = await boot();
    const last = snapshots[snapshots.length - 1];

    expect(last.isInitialized).toBe(true);
    expect(last.isAuthenticated).toBe(true);
    expect(last.user).toMatchObject({ id: 'u1' });
    expect(storage().has(REFRESH_KEY)).toBe(true);
    expect(storage().has(ACCESS_KEY)).toBe(true);
    await act(async () => {
      tree.unmount();
    });
  });

  it('a server-confirmed dead session lands on Login', async () => {
    await withAuthTokens('expired-access-token');

    (globalThis.fetch as jest.Mock).mockImplementation(async (url: string, init?: RequestInit) => {
      recordCall(url, init);
      if (String(url).includes('/api/auth/refresh')) {
        return jsonResponse({ error: 'Invalid refresh token' }, 401);
      }
      return jsonResponse({ user: null }, 401);
    });

    const { tree, snapshots } = await boot();
    const last = snapshots[snapshots.length - 1];

    expect(last.isInitialized).toBe(true);
    expect(last.isAuthenticated).toBe(false);
    expect(last.user).toBeNull();
    expect(storage().has(REFRESH_KEY)).toBe(false);
    await act(async () => {
      tree.unmount();
    });
  });

  it('an unresponsive backend cannot hang the splash forever', async () => {
    await withAuthTokens('valid-access-token');

    (globalThis.fetch as jest.Mock).mockImplementation(
      (url: string, init?: RequestInit) => {
        recordCall(url, init);
        return new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      },
    );

    const { AuthProvider, Probe, snapshots } = observeAuth();
    let tree!: RendererTree;
    await act(async () => {
      tree = ReactTestRenderer.create(
        React.createElement(AuthProvider, null, React.createElement(Probe)),
      );
      // Wait past the mocked auth deadline so the timeout lands inside act().
      await new Promise<void>(resolve => setTimeout(resolve, Env.API_TIMEOUT + 50));
    });
    await settle();

    const last = snapshots[snapshots.length - 1];
    expect(last.isInitialized).toBe(true);
    expect(last.isAuthenticated).toBe(true);
    await act(async () => {
      tree.unmount();
    });
  });
});
