/**
 * Sound Service
 *
 * Manages continuous order-alert audio playback.
 *
 * Foreground: uses the native OrderAlertService via NativeModules.
 * Background/Killed: the native Foreground Service handles playback
 * independently of the React Native JS runtime.
 *
 * Flow:
 *   New Order  →  startOrderAlertSound()  →  alert.mp3 loops
 *   Accept     →  stopOrderAlertSound()   →  playback stops
 *   Reject     →  stopOrderAlertSound()   →  playback stops
 */

import { Platform, NativeModules } from 'react-native';

/* ── Types ── */

export interface OrderAlertData {
  orderId: string;
  customerName?: string;
  itemCount?: string;
  total?: string;
}

/* ── Native bridge ── */

interface NativeSoundModule {
  startOrderAlert(data: {
    orderId: string;
    customerName: string;
    itemCount: string;
    total: string;
  }): void;
  stopOrderAlert(): void;
}

const NativeSound: NativeSoundModule | undefined =
  Platform.OS === 'android' ? NativeModules.NotificationHelper : undefined;

let activeOrderId: string | null = null;

/**
 * Start continuous alert playback.
 * If already playing for the same order, this is a no-op.
 */
export function startOrderAlertSound(data: OrderAlertData): void {
  if (activeOrderId === data.orderId) {
    if (__DEV__) {
      console.log('[SOUND] Already playing for this order, skipping');
      console.tron?.log({ message: '[SOUND] Already playing for this order, skipping' });
    }
    return;
  }

  activeOrderId = data.orderId;

  if (__DEV__) {
    console.log(`[SOUND] Starting order alert`);
    console.log(`[SOUND] Alert audio resource: alert.mp3 (native OrderAlertService)`);
    console.tron?.log({ message: `[SOUND] Starting order alert for ${data.orderId}` });
  }

  if (NativeSound) {
    NativeSound.startOrderAlert({
      orderId: data.orderId,
      customerName: data.customerName ?? '',
      itemCount: data.itemCount ?? '',
      total: data.total ?? '',
    });
  } else {
    if (__DEV__) {
      console.log('[SOUND] Native module unavailable — sound will not play');
    }
  }

  if (__DEV__) {
    console.log(`[SOUND] Alert playback started for ${data.orderId}`);
    console.tron?.log({ message: `[SOUND] Alert playback started for ${data.orderId}` });
  }
}

/**
 * Stop alert playback immediately.
 * Safe to call multiple times.
 */
export function stopOrderAlertSound(): void {
  const wasPlaying = activeOrderId;
  activeOrderId = null;

  if (NativeSound) {
    NativeSound.stopOrderAlert();
  }

  if (__DEV__) {
    const msg = wasPlaying
      ? `[SOUND] Alert playback stopped (was: ${wasPlaying})`
      : '[SOUND] Alert playback stopped (nothing was playing)';
    console.log(msg);
    console.tron?.log({ message: msg });
  }
}

/**
 * Check if an alert is currently playing.
 */
export function isOrderAlertPlaying(): boolean {
  return activeOrderId !== null;
}
