/**
 * Auth Service
 *
 * Centralised data layer for authentication operations.
 * Uses the reusable API client so the base URL is never hard-coded.
 *
 * On login/signup, the backend sets a refreshToken as an httpOnly cookie.
 * React Native's fetch does NOT auto-manage cookies like a browser, so we
 * extract the refreshToken from the Set-Cookie header and store it in
 * AsyncStorage for later use in refresh requests.
 */

import { apiGet, apiPostWithResponse, ApiError } from './api.client';
import {
  saveAuthTokens,
  saveStoredUser as persistUser,
  clearAuthTokens,
  getRefreshToken,
  getStoredUser,
  type StoredUser,
} from './tokenStorage';
import { Env } from '../config/env';

/* ── Types ──────────────────────────────────────────────────────────── */

export interface AuthUser {
  id: string;
  username: string;
  role: string;
  email?: string;
  name?: string;
}

export interface AuthResult {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
}

/* ── Cookie parser ──────────────────────────────────────────────────── */

/**
 * Extract a cookie value from a Set-Cookie header string.
 * Handles: "refreshToken=abc123; Path=/; HttpOnly" → "abc123"
 */
function parseCookieValue(
  setCookieHeader: string | null,
  name: string,
): string | null {
  if (!setCookieHeader) return null;
  // A single Set-Cookie header may contain multiple cookies separated by commas
  // but fetch in RN typically gives us one. Split on ", " for safety.
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

/* ── Public API ─────────────────────────────────────────────────────── */

/**
 * Register a new STAFF account.
 *
 * POST /api/auth/register
 * Sends: { username, password, confirmPassword }
 * Backend returns: { user, accessToken, refreshToken }
 * Backend also sets refreshToken as httpOnly cookie.
 *
 * On success, tokens are persisted and caller is ready to navigate
 * to the authenticated app.
 */
export async function register(
  username: string,
  password: string,
  confirmPassword: string,
): Promise<AuthResult> {
  // Pass undefined as token — register is an unauthenticated endpoint
  const { data: result, response } = await apiPostWithResponse<AuthResult>(
    '/api/auth/register',
    { username, password, confirmPassword },
  );

  // Extract refreshToken from Set-Cookie header
  const setCookie = response.headers.get('set-cookie');
  const cookieRefreshToken = parseCookieValue(setCookie, 'refreshToken');

  // Persist tokens and user info securely
  const rt = cookieRefreshToken || result.refreshToken || '';
  await saveAuthTokens(result.accessToken, rt, result.user);

  return { ...result, refreshToken: rt };
}

/**
 * Register a new user account.
 *
 * POST /api/auth/signup
 * Sends: { email, password, fullName }
 * Backend returns: { token, user } with user having { id, email, name, role }
 * Backend also sets httpOnly cookie: refreshToken=<jwt>
 *
 * On success, tokens are persisted and caller is ready to navigate
 * to the authenticated app.
 */
export async function signup(
  email: string,
  password: string,
  fullName: string,
): Promise<AuthResult> {
  // Pass undefined as token — signup is an unauthenticated endpoint
  const { data: rawResult, response } = await apiPostWithResponse<{
    token?: string;
    accessToken?: string;
    user: StoredUser;
  }>('/api/auth/signup', { email, password, fullName });

  // Extract refreshToken from Set-Cookie header
  const setCookie = response.headers.get('set-cookie');
  const cookieRefreshToken = parseCookieValue(setCookie, 'refreshToken');

  // Backend may return `token` or `accessToken` — normalise
  const tokenValue =
    (rawResult as any).token || (rawResult as any).accessToken || '';

  // Backend may return refreshToken in JSON body or Set-Cookie header
  const refreshTokenValue =
    cookieRefreshToken || (rawResult as any).refreshToken || '';

  // Persist tokens and user info securely
  await saveAuthTokens(tokenValue, refreshTokenValue, rawResult.user);

  return {
    user: rawResult.user,
    accessToken: tokenValue,
    refreshToken: refreshTokenValue,
  };
}

/**
 * Login with email and password.
 *
 * POST /api/auth/login
 * Sends: { email, password }
 * Backend returns: { token, user } with user having { id, email, name, role }
 * Backend also sets httpOnly cookie: refreshToken=<jwt>
 *
 * On success, tokens are persisted and caller is ready to navigate
 * to the authenticated app.
 */
export async function login(
  email: string,
  password: string,
): Promise<AuthResult> {
  // Pass undefined as token to prevent sending a stale Authorization header
  // on this unauthenticated endpoint.
  const { data: rawResult, response } = await apiPostWithResponse<{
    token?: string;
    accessToken?: string;
    user: StoredUser;
  }>('/api/auth/login', { email, password });

  // Extract refreshToken from Set-Cookie header
  const setCookie = response.headers.get('set-cookie');
  const cookieRefreshToken = parseCookieValue(setCookie, 'refreshToken');

  // Backend may return `token` or `accessToken` — normalise
  const tokenValue =
    (rawResult as any).token || (rawResult as any).accessToken || '';

  // Backend may return refreshToken in JSON body or Set-Cookie header
  const refreshTokenValue =
    cookieRefreshToken || (rawResult as any).refreshToken || '';

  // Persist tokens and user info securely
  await saveAuthTokens(tokenValue, refreshTokenValue, rawResult.user);

  return {
    user: rawResult.user,
    accessToken: tokenValue,
    refreshToken: refreshTokenValue,
  };
}

/**
 * Logout — clears stored tokens.
 */
export async function logout(): Promise<void> {
  try {
    const refreshToken = await getRefreshToken();

    if (refreshToken) {
      // Attempt to revoke on the server (best-effort)
      await fetch(`${Env.API_BASE_URL}/api/auth/logout`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      }).catch(() => {});
    }
  } catch {
    // Best-effort: even if server call fails, clear local tokens
  } finally {
    await clearAuthTokens();
  }
}

/**
 * Fetch the current user from the server using the stored access token.
 *
 * GET /api/auth/me
 * Returns: { user: { id, email, name, role, image } }
 *
 * Also persists the returned user to AsyncStorage so subsequent local
 * reads stay in sync with the backend.
 */
export async function fetchCurrentUser(): Promise<StoredUser> {
  const raw = await apiGet<{
    user: {
      id: string;
      email?: string;
      name?: string;
      role?: string;
      image?: string | null;
    } | null;
  }>('/api/auth/me');

  // Backend may return { user: null } when the JWT is valid but user
  // record is missing — fall back to the stored user in that case.
  if (!raw.user) {
    const stored = await getStoredUser();
    if (!stored) {
      throw new ApiError(401, 'No user data available');
    }
    return stored;
  }

  const user: StoredUser = {
    id: raw.user.id,
    username: raw.user.email ?? '',
    email: raw.user.email,
    name: raw.user.name,
    role: raw.user.role ?? 'staff',
  };

  // Persist so local reads stay current
  await persistUser(user);

  return user;
}

/**
 * Get the currently stored user, if any.
 */
export async function getCurrentUser(): Promise<StoredUser | null> {
  return getStoredUser();
}

/**
 * Check if an error is an API error with a specific status.
 */
export function isApiError(error: unknown, status?: number): error is ApiError {
  if (!(error instanceof ApiError)) return false;
  return status != null ? error.status === status : true;
}
