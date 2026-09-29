/**
 * Auth Context
 *
 * Owns authentication state for the app.
 *
 * On mount it restores the session from the stored tokens before exposing the
 * app: the splash screen (see App.tsx) stays visible until `isInitialized`
 * flips, so the login screen is never briefly shown while restoration is in
 * progress. Restoration only ends the session when the server rejects the
 * credentials; a network error keeps the user signed in from the cached
 * profile, and the request itself is bounded by a deadline so the splash can
 * never hang forever.
 */

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  ReactNode,
} from 'react';
import type { StoredUser } from '../services/tokenStorage';
import {
  getStoredUser,
  hasStoredAuth,
  clearAuthTokens,
} from '../services/tokenStorage';
import { onAuthExpired, ApiError } from '../services/api.client';
import { fetchCurrentUser } from '../services/auth.service';
import { queryClient } from '../services/queryClient';
import { Env } from '../config/env';

/* ── Logging ────────────────────────────────────────────────────────── */

/**
 * Dev-only diagnostic log. The full text never includes a token, but these
 * lines describe session state, so they are stripped from release builds.
 */
function log(...args: unknown[]): void {
  if (__DEV__) console.log(...args);
}

/* ── Types ──────────────────────────────────────────────────────────── */

interface AuthState {
  /** True once we finish checking stored tokens on mount */
  isInitialized: boolean;
  /** True if user has valid stored tokens */
  isAuthenticated: boolean;
  /** The currently logged-in user (null when not authenticated) */
  user: StoredUser | null;
}

interface AuthActions {
  /** Mark as authenticated after successful login/register (user passed in) */
  setAuthenticated: (user: StoredUser) => void;
  /** Mark as unauthenticated, clear tokens, and optionally run a callback (e.g. navigation reset) */
  signOut: (onSignOut?: () => void) => Promise<void>;
}

type AuthContextType = AuthState & AuthActions;

/* ── Context ────────────────────────────────────────────────────────── */

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/* ── Startup helper ─────────────────────────────────────────────────── */

/**
 * Reject if `promise` has not settled within `timeoutMs`.
 *
 * The fetch inside fetchCurrentUser has no deadline of its own; without this a
 * request that never answers would leave the splash screen up indefinitely.
 */
function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new ApiError(0, `Auth check timed out (${timeoutMs}ms)`)),
      timeoutMs,
    );
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      err => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/* ── Provider ───────────────────────────────────────────────────────── */

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    isInitialized: false,
    isAuthenticated: false,
    user: null,
  });

  /* On mount: restore the session from stored credentials */
  useEffect(() => {
    let cancelled = false;

    const restoreSession = async () => {
      if (!(await hasStoredAuth())) {
        log('[AUTH-CTX] startup: no stored credentials');
        if (!cancelled) {
          setState({ isInitialized: true, isAuthenticated: false, user: null });
        }
        return;
      }

      try {
        // Confirm with the server before revealing the app.
        const freshUser = await withDeadline(
          fetchCurrentUser(),
          Env.API_TIMEOUT,
        );
        log('[AUTH-CTX] startup: session restored for', freshUser?.username);
        if (!cancelled) {
          setState({
            isInitialized: true,
            isAuthenticated: true,
            user: freshUser,
          });
        }
      } catch (err) {
        // 401 is the server's verdict on the session: sign out.
        const isAuthError = err instanceof ApiError && err.status === 401;
        log(
          '[AUTH-CTX] startup: auth check failed:',
          err instanceof Error ? err.message : err,
        );
        if (cancelled) return;

        if (isAuthError) {
          await clearAuthTokens();
          setState({ isInitialized: true, isAuthenticated: false, user: null });
          return;
        }

        // Offline / timeout / 5xx proves nothing about the session. Restore
        // from the cached profile — but only if credentials are still stored
        // (a refresh failure during the call may have cleared them).
        if (await hasStoredAuth()) {
          const cachedUser = await getStoredUser();
          log('[AUTH-CTX] startup: offline fallback to cached user');
          setState({
            isInitialized: true,
            isAuthenticated: true,
            user: cachedUser,
          });
          return;
        }

        setState({ isInitialized: true, isAuthenticated: false, user: null });
      }
    };

    restoreSession().catch(async () => {
      // Storage itself failed — nothing to restore, but never block the splash.
      if (!cancelled) {
        setState({ isInitialized: true, isAuthenticated: false, user: null });
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const setAuthenticated = useCallback((user: StoredUser) => {
    setState({ isInitialized: true, isAuthenticated: true, user });
  }, []);

  const signOut = useCallback(async (onSignOut?: () => void) => {
    await clearAuthTokens();
    // Drop cached data so the next session cannot read the previous user's
    // orders/products from memory.
    queryClient.clear();
    setState({ isInitialized: true, isAuthenticated: false, user: null });
    onSignOut?.();
  }, []);

  // Register the auth-expired callback so the API client can trigger
  // signOut when the server rejects the refresh token.
  useEffect(() => {
    log('[AUTH-CTX] registering onAuthExpired listener');
    const unsubscribe = onAuthExpired(async () => {
      log('[AUTH-CTX] onAuthExpired — session invalidated by server');
      await clearAuthTokens();
      queryClient.clear();
      setState({ isInitialized: true, isAuthenticated: false, user: null });
    });
    return unsubscribe;
  }, []);

  return (
    <AuthContext.Provider value={{ ...state, setAuthenticated, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

/* ── Hook ───────────────────────────────────────────────────────────── */

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return ctx;
}
