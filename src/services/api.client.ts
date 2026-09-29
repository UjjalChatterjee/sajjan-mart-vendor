/**
 * API Client
 *
 * Lightweight, reusable fetch wrapper for REST API calls.
 * Base URL is pulled from src/config/env so it is never hard-coded
 * inside individual screens or services.
 *
 * Includes automatic 401 → refresh → retry logic:
 *   1. On 401, attempt a token refresh via POST /api/auth/refresh, sending
 *      the stored refresh token in the JSON request body.
 *   2. On success, store the new access and refresh tokens from the JSON
 *      response and retry the original request once.
 *   3. Only a server-confirmed rejection of the refresh token clears the
 *      credentials and signs the user out. Offline, timeouts and 5xx
 *      responses keep the session.
 *   4. Concurrent 401s share a single in-flight refresh request.
 *   5. If the retry itself returns 401, the loop stops (no infinite loop).
 *
 * Authentication is purely token based: the Authorization Bearer header and
 * the JSON body carry every credential. No Cookie header is sent and no
 * Set-Cookie value is read, so nothing depends on a cookie jar.
 */

import { Env } from '../config/env';
import {
  getAccessToken,
  getRefreshToken,
  saveAccessToken,
  saveRefreshToken,
  clearAuthTokens,
} from './tokenStorage';

/* ── Types ──────────────────────────────────────────────────────────── */

export interface ApiResponse<T = unknown> {
  success: boolean;
  message?: string;
  data: T;
}

export interface ApiErrorResponse {
  success: false;
  message: string;
  errors?: Record<string, string>;
}

/* ── Error class ────────────────────────────────────────────────────── */

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /**
     * True only when the server confirmed that the session itself is no
     * longer usable (expired/invalid/deactivated refresh token). Transport
     * failures (offline, abort, 5xx) never set this, so they can never sign
     * the user out.
     */
    public sessionInvalid = false,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/* ── Auth-expired listener ──────────────────────────────────────────── */

type AuthExpiredListener = () => void;
let authExpiredListener: AuthExpiredListener | null = null;

/**
 * Register a callback that fires when the refresh token is expired/invalid
 * and the user must be signed out.  AuthContext should call this once on mount.
 */
export function onAuthExpired(listener: AuthExpiredListener): () => void {
  authExpiredListener = listener;
  return () => {
    authExpiredListener = null;
  };
}

function notifyAuthExpired(): void {
  authExpiredListener?.();
}

/* ── Refresh-token state ────────────────────────────────────────────── */

/**
 * Refresh queue: concurrent 401 callers push their resolve/reject here.
 * The first 401 caller drives the refresh; subsequent ones just wait.
 */
let refreshQueue: {
  resolve: (token: string) => void;
  reject: (err: Error) => void;
}[] = [];

/** Guard: is a refresh currently in progress? */
let isRefreshing = false;

/**
 * fetch() with a hard deadline.
 *
 * Without it a request that never answers leaves `isRefreshing` true for the
 * life of the process, and every later 401 queues behind a promise that can
 * only settle at the OS socket timeout.
 */
function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}

/**
 * Perform the refresh round-trip.
 *
 * POST /api/auth/refresh with body { refreshToken: "<stored token>" } —
 * purely token based: no Cookie header, no Set-Cookie parsing, no cookie jar.
 *
 * Returns the new access token on success.
 *
 * Throws ApiError with sessionInvalid = true only when the server rejected
 * the refresh token. Everything else (offline, abort, 5xx, an unexpected
 * body) is a transport or contract problem that must not end the session.
 */
async function performTokenRefresh(): Promise<string> {
  const refreshToken = await getRefreshToken();

  // Storage holds no refresh token at all, so the session cannot be renewed
  // and is treated as invalidated.
  if (!refreshToken) {
    throw new ApiError(401, 'No refresh token available', true);
  }

  let response: Response;
  try {
    response = await fetchWithTimeout(
      `${Env.API_BASE_URL}/api/auth/refresh`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ refreshToken }),
      },
      Env.API_TIMEOUT,
    );
  } catch {
    // Offline, DNS failure or our own abort: proves nothing about the session.
    throw new ApiError(0, 'Refresh request could not reach the server');
  }

  // 401 = expired/invalid token, 403 = deactivated account. Both are the
  // server's verdict on the session itself.
  if (response.status === 401 || response.status === 403) {
    throw new ApiError(response.status, 'Refresh token expired or invalid', true);
  }

  if (!response.ok) {
    throw new ApiError(response.status, `Refresh failed (${response.status})`);
  }

  let json: {
    accessToken?: string;
    token?: string;
    refreshToken?: string;
  };
  try {
    json = await response.json();
  } catch {
    throw new ApiError(0, 'Refresh returned a non-JSON body');
  }

  // /api/auth/refresh returns { success, accessToken, refreshToken }.
  const newAccessToken = json.accessToken ?? json.token;
  if (!newAccessToken) {
    throw new ApiError(0, 'No access token in refresh response');
  }

  await saveAccessToken(newAccessToken);
  // saveRefreshToken ignores empty/null/undefined, so a response without a
  // rotated token can never overwrite the valid stored one.
  await saveRefreshToken(json.refreshToken);

  return newAccessToken;
}

/**
 * Attempt to refresh the access token.
 *
 * Returns the new access token on success; throws on failure so the original
 * request surfaces its own 401.
 *
 * Concurrent 401 callers share a single in-flight request:
 *   - On success every queued caller receives the new token.
 *   - On failure every queued caller receives the same error, and credentials
 *     are cleared only when the server invalidated the session.
 */
async function refreshAccessToken(): Promise<string> {
  // If a refresh is already in-flight, queue this caller
  if (isRefreshing) {
    return new Promise<string>((resolve, reject) => {
      refreshQueue.push({ resolve, reject });
    });
  }

  isRefreshing = true;

  try {
    const newAccessToken = await performTokenRefresh();

    // Resolve ALL queued callers with the new token
    for (const entry of refreshQueue) {
      entry.resolve(newAccessToken);
    }
    refreshQueue = [];

    return newAccessToken;
  } catch (err) {
    const error =
      err instanceof ApiError
        ? err
        : new ApiError(0, err instanceof Error ? err.message : String(err));

    if (error.sessionInvalid) {
      await clearAuthTokens();
      notifyAuthExpired();
    }

    // Reject ALL queued callers with the same error
    for (const entry of refreshQueue) {
      entry.reject(error);
    }
    refreshQueue = [];

    throw error;
  } finally {
    isRefreshing = false;
  }
}

/* ── Helpers ────────────────────────────────────────────────────────── */

function buildHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

/* ── Central request handler ────────────────────────────────────────── */

/**
 * Internal fetch that does NOT auto-retry on 401.
 * Used for the original request and the retry after refresh.
 */
async function fetchJson<T>(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ data: T; response: Response }> {
  const response = await fetch(url, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });

  const rawText = await response.text();
  let json: ApiResponse<T> | ApiErrorResponse;
  try {
    json = JSON.parse(rawText) as ApiResponse<T> | ApiErrorResponse;
  } catch {
    // A gateway/cold-start HTML page is not an API contract answer. Keep the
    // HTTP status so a 401 can still trigger a refresh and a 5xx stays a
    // transient failure instead of a raw SyntaxError.
    throw new ApiError(
      response.status,
      rawText.slice(0, 200) || `Request failed (${response.status})`,
    );
  }

  if (
    !response.ok ||
    json.success === false ||
    (json as ApiErrorResponse).success === false
  ) {
    const message =
      (json as ApiErrorResponse).message ||
      (json as { error?: string }).error ||
      `Request failed (${response.status})`;
    throw new ApiError(response.status, message);
  }

  return { data: json as T, response };
}

/**
 * Central request handler.  Throws a descriptive error on non-2xx
 * so callers can `catch` it uniformly.
 * Automatically includes the auth token from storage if not provided.
 *
 * On 401: attempts a token refresh and retries once.
 * If refresh fails, clears auth and notifies listeners (via refreshAccessToken).
 *
 * Infinite-loop prevention:
 *   - The refresh endpoint itself is excluded from refresh attempts.
 *   - After a refresh succeeds, the retried request uses the fresh token.
 *     If that retried request STILL gets401 (e.g. token revoked),
 *     the guard `retryWithRefresh` prevents a second refresh attempt.
 */
async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<T> {
  const url = `${Env.API_BASE_URL}${path}`;

  // Automatically include token from storage if not explicitly provided
  const finalToken = token || (await getAccessToken());

  // Closure flag: at most one refresh per request lifecycle
  let retryWithRefresh = false;

  const fetchOnce = async (authToken?: string): Promise<T> => {
    const { data } = await fetchJson<T>(
      method,
      url,
      buildHeaders(authToken),
      body,
    );
    return data;
  };

  try {
    return await fetchOnce(finalToken as string | undefined);
  } catch (err) {
    // Only handle401 errors for refresh
    if (!(err instanceof ApiError && err.status === 401)) {
      throw err;
    }

    // Don't try to refresh if THIS request IS the refresh endpoint
    if (path === '/api/auth/refresh') {
      throw err;
    }

    // Already retried after a refresh — do NOT loop
    if (retryWithRefresh) {
      throw err;
    }
    retryWithRefresh = true;

    // Attempt token refresh (queued if concurrent401s arrive)
    const newToken = await refreshAccessToken();

    // Retry the original request with the new token
    return await fetchOnce(newToken);
  }
}

/* ── Public helpers ─────────────────────────────────────────────────── */

export async function apiGet<T>(path: string, token?: string): Promise<T> {
  return request<T>('GET', path, undefined, token);
}

export async function apiPost<T>(
  path: string,
  body?: unknown,
  token?: string,
): Promise<T> {
  return request<T>('POST', path, body, token);
}

export async function apiPut<T>(
  path: string,
  body?: unknown,
  token?: string,
): Promise<T> {
  return request<T>('PUT', path, body, token);
}

/**
 * POST for an unauthenticated endpoint (login/signup/register).
 *
 * Unlike request(), it never attaches a stored bearer token — the credential
 * pair comes back in the JSON body and is persisted by the caller.
 */
export async function apiPostWithResponse<T>(
  path: string,
  body?: unknown,
): Promise<{ data: T; response: Response }> {
  const url = `${Env.API_BASE_URL}${path}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const rawText = await response.text();

  let json: T;
  try {
    json = JSON.parse(rawText) as T;
  } catch {
    throw new ApiError(
      response.status,
      rawText || `Invalid JSON response (${response.status})`,
    );
  }

  if (!response.ok) {
    const errorBody = json as any;
    throw new ApiError(
      response.status,
      errorBody?.message ||
        errorBody?.error ||
        `Request failed (${response.status})`,
    );
  }

  return { data: json, response };
}
