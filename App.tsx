/**
 * Sajjan Mart – Store Staff Order Management
 *
 * @format
 */

import React, { useEffect, useRef, useState } from 'react';
import { StatusBar, View, StyleSheet, AppState } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './src/services/queryClient';
import { AuthProvider, useAuth } from './src/context/AuthContext';
import { NavigationProvider, useNavigation } from './src/context/NavigationContext';
import { OrderStoreProvider } from './src/store/orderStore';
import { ToastProvider } from './src/context/ToastContext';
import { LoginScreen } from './src/screens/LoginScreen';
import { OrdersScreen } from './src/screens/OrdersScreen';
import { NotificationSettingsScreen } from './src/screens/NotificationSettingsScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { Colors } from './src/theme/colors';
import { SplashScreen } from './src/components/SplashScreen';
import {
  initializeNotifications,
  resetNotificationInitialization,
  consumePendingOrdersNavigation,
  removeOpenOrdersHandler,
  setOpenOrdersHandler,
} from './src/services/notification.service';
import { reconcileAlertsWithBackend } from './src/services/orderAlertSync';

/**
 * Screen router — decides between auth screens and the main app.
 */
function AppContent() {
  const { isInitialized, isAuthenticated, user } = useAuth();
  const { state, navigate, resetHistoryToLogin } = useNavigation();
  const wasAuthenticated = useRef(isAuthenticated);
  const [showSplash, setShowSplash] = useState(true);

  console.log('[APP] AppContent render: isInitialized=', isInitialized, '| isAuthenticated=', isAuthenticated, '| nav screen=', state.screen, '| showSplash=', showSplash);

  /* The background / killed order alert is generic by design, so a tap has one
     meaning: show the pending orders. AppContent owns the only navigation
     state, and the history survives restarts, so the tap must navigate
     explicitly instead of hoping the remembered screen is Orders.
       app alive   → native pushes "NotificationOpenOrders" → this handler
       cold start  → MainActivity stashes the flag → pulled once per session */
  useEffect(() => {
    if (!isAuthenticated) {
      removeOpenOrdersHandler();
      return;
    }
    const openOrders = () => {
      console.log('[ORDER-TAP] Opening Orders screen from notification tap');
      navigate('orders');
    };
    setOpenOrdersHandler(openOrders);
    consumePendingOrdersNavigation().then(pending => {
      if (pending) openOrders();
    });
    return () => removeOpenOrdersHandler();
  }, [isAuthenticated, navigate]);

  /* FCM bootstrap for EVERY authenticated session — including sessions
     restored on app restart, where LoginScreen is never mounted.
     initializeNotifications() is idempotent per user id. */
  useEffect(() => {
    if (!isAuthenticated) {
      resetNotificationInitialization();
      return;
    }
    console.log('[APP] Authenticated session — ensuring notifications are initialized');
    initializeNotifications(user?.id ?? null).catch(err => {
      console.warn(
        '[APP] Notification initialization failed:',
        err instanceof Error ? err.message : String(err),
      );
    });
  }, [isAuthenticated, user?.id]);

  /* Coming back to the foreground is the reconnect point for a device that was
     offline while another device accepted or rejected an order: any alert whose
     order is no longer pending is dropped before it can be shown again. */
  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }
    const subscription = AppState.addEventListener('change', status => {
      if (status === 'active') {
        reconcileAlertsWithBackend().catch(() => {
          /* reconciliation retries on the next resume or list refresh */
        });
      }
    });
    return () => subscription.remove();
  }, [isAuthenticated]);

  /* When auth drops to false (logout / token expiry), always reset nav to login */
  useEffect(() => {
    console.log('[APP] auth effect: wasAuthenticated=', wasAuthenticated.current, '| isAuthenticated=', isAuthenticated);
    if (wasAuthenticated.current && !isAuthenticated) {
      console.log('[APP] auth dropped — calling resetHistoryToLogin()');
      resetHistoryToLogin();
    }
    wasAuthenticated.current = isAuthenticated;
  }, [isAuthenticated, resetHistoryToLogin]);

  /* Handle splash animation completion */
  const handleSplashComplete = () => {
    console.log('[APP] Splash animation complete');
    setShowSplash(false);
  };

  /* Show splash while initializing or during splash animation */
  if (!isInitialized || showSplash) {
    return <SplashScreen onAnimationComplete={handleSplashComplete} />;
  }

  /* Not authenticated — always show Login, no matter what screen the nav thinks we're on */
  if (!isAuthenticated) {
    console.log('[APP] rendering LoginScreen (isAuthenticated=false)');
    return (
      <View style={styles.root}>
        <LoginScreen />
      </View>
    );
  }

  /* Authenticated — show main app screens */
  console.log('[APP] rendering main app, screen=', state.screen);
  return (
    <View style={styles.root}>
      {state.screen === 'orders' && <OrdersScreen />}
      {state.screen === 'notifications' && <NotificationSettingsScreen />}
      {state.screen === 'settings' && <SettingsScreen />}
      {/* Fallback: if screen doesn't match any known screen, show Orders */}
      {!['orders', 'notifications', 'settings'].includes(state.screen) && (
        <OrdersScreen />
      )}
    </View>
  );
}

function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <NavigationProvider>
            <OrderStoreProvider>
              <ToastProvider>
                <AppContent />
              </ToastProvider>
            </OrderStoreProvider>
          </NavigationProvider>
        </AuthProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});

export default App;
