/**
 * Token Storage
 *
 * Secure wrapper around AsyncStorage for persisting auth tokens.
 * Never logs tokens or passwords in any environment.
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

export async function saveAuthTokens(
  accessToken: string,
  refreshToken: string,
  user: StoredUser,
): Promise<void> {
  await AsyncStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
  await AsyncStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  await AsyncStorage.setItem(USER_KEY, JSON.stringify(user));
}

/* ── Update ─────────────────────────────────────────────────────────── */

/** Update only the access token (used after token refresh). */
export async function saveAccessToken(accessToken: string): Promise<void> {
  await AsyncStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
}

/** Update only the refresh token (used when backend rotates refresh tokens). */
export async function saveRefreshToken(refreshToken: string): Promise<void> {
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

export async function hasStoredAuth(): Promise<boolean> {
  const token = await AsyncStorage.getItem(ACCESS_TOKEN_KEY);
  return token != null;
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
