/**
 * Token Storage
 *
 * Persistence layer for auth tokens and the cached user, built on
 * AsyncStorage. Never logs tokens or passwords in any environment.
 *
 * Note on "secure" storage: this project has no keychain/secure-enclave
 * library installed (see package.json). Introducing one would split token
 * ownership between two stores and change every read/write path, so this
 * module stays the single source of truth. If a secure store is added later,
 * only this file should change.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Screen } from '../types';

const ACCESS_TOKEN_KEY = '@sajjanmart:accessToken';
const REFRESH_TOKEN_KEY = '@sajjanmart:refreshToken';
const USER_KEY = '@sajjanmart:user';

/* ── Types ──────────────────────────────────────────────────────────── */

export interface StoredUser {
  id: string;
  username: string;
  email?: string;
  name?: string;
  role: string;
}

/* ── Save ───────────────────────────────────────────────────────────── */

/**
 * Persist the token pair + user after login/signup/register/refresh.
 *
 * Empty/null/undefined values are skipped: a partially-filled auth response
 * must never wipe a credential that still works.
 */
export async function saveAuthTokens(
  accessToken: string | null | undefined,
  refreshToken: string | null | undefined,
  user: StoredUser,
): Promise<void> {
  if (accessToken) await AsyncStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
  if (refreshToken) await AsyncStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  await AsyncStorage.setItem(USER_KEY, JSON.stringify(user));
}

/* ── Update ─────────────────────────────────────────────────────────── */

/** Update only the access token (used after token refresh). */
export async function saveAccessToken(accessToken: string): Promise<void> {
  if (!accessToken) return;
  await AsyncStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
}

/**
 * Update only the refresh token (used when the backend rotates it).
 *
 * Accepts the optional field from a refresh response: a missing/empty value
 * means "not rotated" and must leave the stored token untouched.
 */
export async function saveRefreshToken(
  refreshToken?: string | null,
): Promise<void> {
  if (!refreshToken) return;
  await AsyncStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
}

/** Update only the stored user (used after /me refresh). */
export async function saveStoredUser(user: StoredUser): Promise<void> {
  await AsyncStorage.setItem(USER_KEY, JSON.stringify(user));
}

/* ── Read ───────────────────────────────────────────────────────────── */

export async function getAccessToken(): Promise<string | null> {
  return AsyncStorage.getItem(ACCESS_TOKEN_KEY);
}

export async function getRefreshToken(): Promise<string | null> {
  return AsyncStorage.getItem(REFRESH_TOKEN_KEY);
}

export async function getStoredUser(): Promise<StoredUser | null> {
  const raw = await AsyncStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredUser;
  } catch {
    return null;
  }
}

/* ── Clear ──────────────────────────────────────────────────────────── */

export async function clearAuthTokens(): Promise<void> {
  await AsyncStorage.removeItem(ACCESS_TOKEN_KEY);
  await AsyncStorage.removeItem(REFRESH_TOKEN_KEY);
  await AsyncStorage.removeItem(USER_KEY);
  await AsyncStorage.removeItem(NAVIGATION_KEY);
}

/* ── Check ──────────────────────────────────────────────────────────── */

/**
 * True when any credential is stored.
 *
 * A refresh token alone counts: the access token expires after 15m and can be
 * renewed silently, so treating it as "signed out" would throw the user to the
 * login screen while a valid session still exists.
 */
export async function hasStoredAuth(): Promise<boolean> {
  const [accessToken, refreshToken] = await Promise.all([
    AsyncStorage.getItem(ACCESS_TOKEN_KEY),
    AsyncStorage.getItem(REFRESH_TOKEN_KEY),
  ]);
  return Boolean(accessToken || refreshToken);
}

/* ── Navigation state persistence ────────────────────────────────────── */

export const NAVIGATION_KEY = '@sajjanmart:navigation';

export interface NavState {
  screen: Screen;
  orderId: string | null;
}

/** Save the FULL navigation history (array of NavState entries). */
export async function getSavedNavHistory(): Promise<NavState[] | null> {
  const raw = await AsyncStorage.getItem(NAVIGATION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    // Backward compat: if it's a single object (old format), wrap in array
    if (Array.isArray(parsed)) {
      return parsed as NavState[];
    }
    if (parsed && typeof parsed === 'object' && 'screen' in parsed) {
      return [parsed as NavState];
    }
    return null;
  } catch {
    return null;
  }
}

/** Save the FULL navigation history (array of NavState entries). */
export async function saveNavHistory(history: NavState[]): Promise<void> {
  await AsyncStorage.setItem(NAVIGATION_KEY, JSON.stringify(history));
}
