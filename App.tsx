/**
 * Sajjan Mart – Store Staff Order Management
 *
 * @format
 */

import React, { useEffect, useRef } from 'react';
import { StatusBar, View, StyleSheet, ActivityIndicator } from 'react-native';
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

/**
 * Loading screen shown while checking for stored auth tokens on startup.
 */
function AuthLoadingScreen() {
  return (
    <View style={styles.loadingRoot}>
      <ActivityIndicator size="large" color={Colors.primary} />
    </View>
  );
}

/**
 * Screen router — decides between auth screens and the main app.
 */
function AppContent() {
  const { isInitialized, isAuthenticated } = useAuth();
  const { state, resetHistoryToLogin } = useNavigation();
  const wasAuthenticated = useRef(isAuthenticated);

  console.log('[APP] AppContent render: isInitialized=', isInitialized, '| isAuthenticated=', isAuthenticated, '| nav screen=', state.screen);

  /* When auth drops to false (logout / token expiry), always reset nav to login */
  useEffect(() => {
    console.log('[APP] auth effect: wasAuthenticated=', wasAuthenticated.current, '| isAuthenticated=', isAuthenticated);
    if (wasAuthenticated.current && !isAuthenticated) {
      console.log('[APP] auth dropped — calling resetHistoryToLogin()');
      resetHistoryToLogin();
    }
    wasAuthenticated.current = isAuthenticated;
  }, [isAuthenticated, resetHistoryToLogin]);

  /* Still checking stored tokens on mount */
  if (!isInitialized) {
    return <AuthLoadingScreen />;
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
  loadingRoot: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: Colors.screenBg,
  },
});

export default App;
