/**
 * Auth Service
 *
 * Centralised data layer for authentication operations.
 * Uses the reusable API client so the base URL is never hard-coded.
 *
 * Authentication is purely token based. /api/auth/login and /api/auth/signup
 * return { accessToken, refreshToken } in the JSON body and those values are
 * the only ones this app reads — the accompanying httpOnly cookies belong to
 * the web client and are deliberately ignored here (no Cookie header is ever
 * sent, no Set-Cookie header is ever parsed).
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

/**
 * Login/signup/register return the access token as `accessToken`; older builds
 * named it `token`. Only the JSON body is ever read.
 */
interface TokenResponse {
  token?: string;
  accessToken?: string;
  refreshToken?: string;
  user: StoredUser;
}

function readTokenPair(body: TokenResponse): {
  accessToken: string;
  refreshToken: string;
} {
  return {
    accessToken: body.accessToken || body.token || '',
    refreshToken: body.refreshToken || '',
  };
}

/* ── Public API ─────────────────────────────────────────────────────── */

/**
 * Register a new STAFF account.
 *
 * POST /api/auth/register
 * Sends: { username, password, confirmPassword }
 * Backend returns: { user, accessToken, refreshToken }
 *
 * On success, tokens are persisted and caller is ready to navigate
 * to the authenticated app.
 */
export async function register(
  username: string,
  password: string,
  confirmPassword: string,
): Promise<AuthResult> {
  const { data: result } = await apiPostWithResponse<AuthResult>(
    '/api/auth/register',
    { username, password, confirmPassword },
  );

  // Both tokens come from the JSON response body.
  await saveAuthTokens(result.accessToken, result.refreshToken, result.user);

  return { ...result, refreshToken: result.refreshToken };
}

/**
 * Register a new user account.
 *
 * POST /api/auth/signup
 * Sends: { email, password, fullName }
 * Backend returns: { ...tokens, user } — accessToken and refreshToken are both
 * in the JSON body and are the only values read here.
 *
 * On success, tokens are persisted and caller is ready to navigate
 * to the authenticated app.
 */
export async function signup(
  email: string,
  password: string,
  fullName: string,
): Promise<AuthResult> {
  const { data: rawResult } = await apiPostWithResponse<TokenResponse>(
    '/api/auth/signup',
    { email, password, fullName },
  );

  const tokens = readTokenPair(rawResult);

  await saveAuthTokens(tokens.accessToken, tokens.refreshToken, rawResult.user);

  return {
    user: rawResult.user,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
  };
}

/**
 * Login with email and password.
 *
 * POST /api/auth/login
 * Sends: { email, password }
 * Backend returns: { ...tokens, user } — accessToken and refreshToken are both
 * in the JSON body and are the only values read here.
 *
 * On success, tokens are persisted and caller is ready to navigate
 * to the authenticated app.
 */
export async function login(
  email: string,
  password: string,
): Promise<AuthResult> {
  const { data: rawResult } = await apiPostWithResponse<TokenResponse>(
    '/api/auth/login',
    { email, password },
  );

  const tokens = readTokenPair(rawResult);

  await saveAuthTokens(tokens.accessToken, tokens.refreshToken, rawResult.user);

  return {
    user: rawResult.user,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
  };
}

/**
 * Logout — asks the server to end the session (best-effort), then clears
 * locally stored tokens.
 *
 * No cookie transport is used: the request carries the refresh token in the
 * JSON body, exactly like the other auth endpoints.
 */
export async function logout(): Promise<void> {
  try {
    const refreshToken = await getRefreshToken();

    if (refreshToken) {
      // Attempt to revoke on the server (best-effort)
      await fetch(`${Env.API_BASE_URL}/api/auth/logout`, {
        method: 'POST',
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
