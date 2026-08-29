/**
 * Auth Context
 *
 * Manages authentication state across the app.
 * Checks for stored tokens on startup and provides login/logout/register actions.
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
import { getStoredUser, hasStoredAuth, clearAuthTokens } from '../services/tokenStorage';
import { onAuthExpired, ApiError } from '../services/api.client';
import { fetchCurrentUser } from '../services/auth.service';

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

/* ── Provider ───────────────────────────────────────────────────────── */

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    isInitialized: false,
    isAuthenticated: false,
    user: null,
  });

  /* On mount: check for stored auth */
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        console.log('[AUTH-CTX] startup: checking stored auth...');
        const hasAuth = await hasStoredAuth();
        console.log('[AUTH-CTX] startup: hasStoredAuth =', hasAuth);
        if (cancelled) return;

        if (hasAuth) {
          // Verify the token is still valid by calling /me BEFORE showing anything.
          // Loading spinner stays visible until we confirm the token works.
          try {
            console.log('[AUTH-CTX] startup: calling fetchCurrentUser()...');
            const freshUser = await fetchCurrentUser();
            console.log('[AUTH-CTX] startup: fetchCurrentUser SUCCESS, user:', freshUser?.username);
            if (!cancelled) {
              setState({
                isInitialized: true,
                isAuthenticated: true,
                user: freshUser,
              });
              console.log('[AUTH-CTX] startup: setState isAuthenticated=true');
            }
          } catch (err) {
            // Token invalid or user deleted — clear auth and show login
            const isAuthError = err instanceof ApiError && err.status === 401;
            console.log('[AUTH-CTX] startup: fetchCurrentUser FAILED');
            console.log('[AUTH-CTX] startup: error type:', err?.constructor?.name, '| is401:', isAuthError, '| message:', err instanceof Error ? err.message : err);
            if (!cancelled) {
              if (isAuthError) {
                console.log('[AUTH-CTX] startup: AUTH ERROR (401) — clearing tokens, setting isAuthenticated=false');
                await clearAuthTokens();
                setState({ isInitialized: true, isAuthenticated: false, user: null });
              } else {
                // Network error — fall back to cached user so app works offline
                console.log('[AUTH-CTX] startup: NETWORK/OTHER ERROR — falling back to cached user');
                const cachedUser = await getStoredUser();
                console.log('[AUTH-CTX] startup: cached user:', cachedUser?.username ?? 'null');
                setState({
                  isInitialized: true,
                  isAuthenticated: true,
                  user: cachedUser ?? null,
                });
                console.log('[AUTH-CTX] startup: setState isAuthenticated=true (cached fallback)');
              }
            }
          }
        } else {
          console.log('[AUTH-CTX] startup: no stored auth, setting isAuthenticated=false');
          if (!cancelled) {
            setState({ isInitialized: true, isAuthenticated: false, user: null });
          }
        }
      } catch {
        console.log('[AUTH-CTX] startup: outer catch — setting isAuthenticated=false');
        if (!cancelled) {
          setState({ isInitialized: true, isAuthenticated: false, user: null });
        }
      }
    })();

    return () => { cancelled = true; };
  }, []);

  const setAuthenticated = useCallback((user: StoredUser) => {
    setState({ isInitialized: true, isAuthenticated: true, user });
  }, []);

  const signOut = useCallback(async (onSignOut?: () => void) => {
    await clearAuthTokens();
    setState({ isInitialized: true, isAuthenticated: false, user: null });
    onSignOut?.();
  }, []);

  // Register the auth-expired callback so the API client can trigger
  // signOut when a refresh token is expired/invalid.
  useEffect(() => {
    console.log('[AUTH-CTX] registering onAuthExpired listener');
    const unsubscribe = onAuthExpired(async () => {
      console.log('[AUTH-CTX] onAuthExpired FIRED — clearing tokens and setting isAuthenticated=false');
      // Clear any remaining stored tokens
      await clearAuthTokens();
      console.log('[AUTH-CTX] onAuthExpired: tokens cleared, setting state');
      setState({ isInitialized: true, isAuthenticated: false, user: null });
      console.log('[AUTH-CTX] onAuthExpired: setState complete');
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
