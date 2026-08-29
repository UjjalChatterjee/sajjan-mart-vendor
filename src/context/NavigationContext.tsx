import React, { createContext, useContext, useState, useCallback, useEffect, useRef, ReactNode } from 'react';
import { BackHandler } from 'react-native';
import type { Screen } from '../types';
import { getSavedNavHistory, saveNavHistory } from '../services/tokenStorage';

interface NavigationState {
  screen: Screen;
  orderId: string | null;
}

interface NavigationContextType {
  state: NavigationState;
  navigate: (screen: Screen, orderId?: string) => void;
  goBack: () => void;
  canGoBack: boolean;
  resetHistoryToLogin: () => void;
}

const NavigationContext = createContext<NavigationContextType | undefined>(undefined);

function persistHistory(history: NavigationState[]) {
  saveNavHistory(history).catch(() => {});
}

export function NavigationProvider({ children }: { children: ReactNode }) {
  const [history, setHistory] = useState<NavigationState[]>([{ screen: 'login', orderId: null }]);

  useEffect(() => {
    (async () => {
      const saved = await getSavedNavHistory();
      if (saved && saved.length > 0) {
        console.log('[NAV] restored history:', JSON.stringify(saved));
        setHistory(saved);
      }
    })();
  }, []);

  const state = history[history.length - 1];
  const canGoBack = history.length > 1;

  const navigate = useCallback((screen: Screen, orderId?: string) => {
    setHistory(prev => {
      const next = [...prev, { screen, orderId: orderId ?? null }];
      console.log('[NAV] navigate →', screen, '| len:', next.length, '| history:', JSON.stringify(next));
      persistHistory(next);
      return next;
    });
  }, []);

  const goBack = useCallback(() => {
    setHistory(prev => {
      const next = prev.length > 1 ? prev.slice(0, -1) : prev;
      console.log('[NAV] goBack →', next[next.length - 1]?.screen, '| len:', next.length);
      persistHistory(next);
      return next;
    });
  }, []);

  const resetHistoryToLogin = useCallback(() => {
    const next: NavigationState[] = [{ screen: 'login', orderId: null }];
    console.log('[NAV] resetToLogin — resetting to login, previous screen:', history[history.length - 1]?.screen);
    setHistory(next);
    persistHistory(next);
  }, [history]);

  const canGoBackRef = useRef(canGoBack);
  canGoBackRef.current = canGoBack;

  useEffect(() => {
    const handler = () => {
      console.log('[NAV] androidBack canGoBack:', canGoBackRef.current);
      if (canGoBackRef.current) {
        goBack();
        return true;
      }
      return false;
    };
    const subscription = BackHandler.addEventListener('hardwareBackPress', handler);
    return () => subscription.remove();
  }, [goBack]);

  return (
    <NavigationContext.Provider value={{ state, navigate, goBack, canGoBack, resetHistoryToLogin }}>
      {children}
    </NavigationContext.Provider>
  );
}

export function useNavigation(): NavigationContextType {
  const context = useContext(NavigationContext);
  if (!context) {
    throw new Error('useNavigation must be used within NavigationProvider');
  }
  return context;
}
