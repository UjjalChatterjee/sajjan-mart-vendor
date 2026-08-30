/**
 * API Client
 *
 * Lightweight, reusable fetch wrapper for REST API calls.
 * Base URL is pulled from src/config/env so it is never hard-coded
 * inside individual screens or services.
 *
 * Includes automatic 401 → refresh → retry logic:
 *   1. On 401, attempt a token refresh via POST /api/auth/refresh
 *      with the stored refreshToken sent as a Cookie header.
 *   2. On success, update the stored access token and retry the
 *      original request once.
 *   3. On refresh failure (401), clear auth and notify listeners.
 *   4. Concurrent 401s share a single in-flight refresh request.
 *   5. If the retry itself returns 401, the loop stops (no infinite loop).
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
  constructor(public status: number, message: string) {
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
 * Refresh queue: concurrent401 callers push their resolve/reject here.
 * The first401 caller drives the refresh; subsequent ones just wait.
 */
let refreshQueue: {
  resolve: (token: string) => void;
  reject: (err: Error) => void;
}[] = [];

/** Guard: is a refresh currently in progress? */
let isRefreshing = false;

/**
 * Parse a cookie value from a Set-Cookie header.
 * Handles: "refreshToken=abc123; Path=/; HttpOnly" → "abc123"
 */
function parseCookieValue(
  setCookieHeader: string | null,
  name: string,
): string | null {
  if (!setCookieHeader) return null;
  const cookies = setCookieHeader.split(/,(?=\s*\w+=)/);
  for (const cookie of cookies) {
    const trimmed = cookie.trim();
    if (trimmed.startsWith(`${name}=`)) {
      const value = trimmed.split(';')[0]?.split('=')[1]?.trim();
      return value || null;
    }
  }
  return null;
}

/**
 * Attempt to refresh the access token.
 *
 * POST /api/auth/refresh
 * Cookie header: refreshToken=<stored refreshToken>
 *
 * Returns the new access token on success.
 * Throws ApiError(401) on failure (caller should sign out).
 *
 * Concurrent401 callers share a single in-flight request.
 * On success: all queued callers receive the new token.
 * On failure: all queued callers receive the error.
 *            Tokens are cleared and the auth-expired listener fires once.
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
    const refreshToken = await getRefreshToken();

    // No refresh token stored → cannot refresh
    if (!refreshToken) {
      throw new ApiError(401, 'No refresh token available');
    }

    const url = `${Env.API_BASE_URL}/api/auth/refresh`;

    const response = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        // Send the refresh token as a Cookie header — NOT in the body
        Cookie: `refreshToken=${refreshToken}`,
      },
    });

    if (response.status === 401) {
      throw new ApiError(401, 'Refresh token expired or invalid');
    }

    if (!response.ok) {
      throw new ApiError(
        response.status,
        `Refresh failed (${response.status})`,
      );
    }

    const json = await response.json();

    // Backend returns { token, user } on success
    const newAccessToken: string = json.token;
    if (!newAccessToken) {
      throw new ApiError(401, 'No token in refresh response');
    }

    // Persist the new access token
    await saveAccessToken(newAccessToken);

    // If the backend rotated the refresh token, save the new one
    if (json.refreshToken) {
      await saveRefreshToken(json.refreshToken);
    }

    // Also check the Set-Cookie header for a new refresh token
    const setCookie = response.headers.get('set-cookie');
    const cookieRefreshToken = parseCookieValue(setCookie, 'refreshToken');
    if (cookieRefreshToken) {
      await saveRefreshToken(cookieRefreshToken);
    }

    // Resolve ALL queued callers with the new token
    for (const entry of refreshQueue) {
      entry.resolve(newAccessToken);
    }
    refreshQueue = [];

    return newAccessToken;
  } catch (err) {
    // Refresh failed — clear ALL auth data and notify once
    await clearAuthTokens();
    notifyAuthExpired();

    // Reject ALL queued callers with the same error
    const error = err instanceof Error ? err : new Error(String(err));
    for (const entry of refreshQueue) {
      entry.reject(error);
    }
    refreshQueue = [];

    throw err;
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
    credentials: 'include',
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });

  const json: ApiResponse<T> | ApiErrorResponse = await response.json();

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
 * POST that also returns the raw Response (for reading Set-Cookie headers).
 * Used by auth.service.ts to capture the refreshToken cookie after login/signup.
 * Does NOT send an existing access token — login/signup are unauthenticated.
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
