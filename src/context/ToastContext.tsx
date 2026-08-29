/**
 * Toast Context
 *
 * Centralised success-toast mechanism. Any component in the tree can call
 * `showSuccess(message)` to display a transient success notification.
 *
 * Usage:
 *   const { showSuccess } = useToast();
 *   showSuccess('Order rejected successfully');
 */

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  ReactNode,
} from 'react';

interface ToastState {
  message: string;
  visible: boolean;
  variant: 'success' | 'error';
}

interface ToastContextType {
  /** Show a success toast that auto-dismisses after `duration` ms */
  showSuccess: (message: string, duration?: number) => void;
  /** Show an error toast that auto-dismisses after `duration` ms */
  showError: (message: string, duration?: number) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState>({ message: '', visible: false, variant: 'success' });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((message: string, variant: 'success' | 'error', duration = 2500) => {
    // Clear any pending dismiss timer
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    // Show immediately
    setToast({ message, visible: true, variant });

    // Auto-dismiss
    timerRef.current = setTimeout(() => {
      setToast(prev => ({ ...prev, visible: false }));
      timerRef.current = null;
    }, duration);
  }, []);

  const showSuccess = useCallback((message: string, duration?: number) => {
    showToast(message, 'success', duration);
  }, [showToast]);

  const showError = useCallback((message: string, duration?: number) => {
    showToast(message, 'error', duration);
  }, [showToast]);

  return (
    <ToastContext.Provider value={{ showSuccess, showError }}>
      {children}
      {/* Rendered at provider level — always on top */}
      <ToastOverlay toast={toast} />
    </ToastContext.Provider>
  );
}

/**
 * Internal overlay that renders the actual toast UI.
 * Kept inside ToastContext to avoid extra prop threading.
 */
function ToastOverlay({ toast }: { toast: ToastState }) {
  if (!toast.visible) return null;

  return (
    <Toast message={toast.message} variant={toast.variant} />
  );
}

export function useToast(): ToastContextType {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within ToastProvider');
  }
  return ctx;
}

/* ── Toast UI (success style) ──────────────────────────────────────── */

import { View, Text, StyleSheet, Animated } from 'react-native';
import { useEffect, useRef as useAnimRef } from 'react';

function Toast({ message, variant }: { message: string; variant: 'success' | 'error' }) {
  const opacity = useAnimRef(new Animated.Value(0)).current;

  useEffect(() => {
    // Fade in
    Animated.timing(opacity, {
      toValue: 1,
      duration: 200,
      useNativeDriver: true,
    }).start();
  }, [opacity]);

  const isError = variant === 'error';
  const bgColor = isError ? '#991B1B' : '#065F46';
  const dotBg = isError ? '#EF4444' : '#10B981';
  const symbol = isError ? '✕' : '✓';

  return (
    <Animated.View style={[styles.container, { opacity }]}>
      <View style={[styles.toast, { backgroundColor: bgColor }]}>
        <Text style={[styles.checkmark, { backgroundColor: dotBg }]}>{symbol}</Text>
        <Text style={styles.text} numberOfLines={2}>
          {message}
        </Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 60,
    left: 16,
    right: 16,
    zIndex: 9999,
    alignItems: 'center',
  },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#065F46',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 12,
    gap: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
    maxWidth: 400,
  },
  checkmark: {
    fontSize: 16,
    fontWeight: '700',
    color: '#FFFFFF',
    backgroundColor: '#10B981',
    width: 24,
    height: 24,
    borderRadius: 12,
    textAlign: 'center',
    lineHeight: 24,
    overflow: 'hidden',
  },
  text: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '500',
    flexShrink: 1,
  },
});
