/**
 * Sound Service
 *
 * Manages continuous order-alert audio playback.
 *
 * Foreground: plays alert.mp3 directly via NotificationHelperModule
 *   (MediaPlayer only — no foreground service, no notification).
 *   The in-app modal IS the foreground UI.
 *
 * Background/Killed: the native OrderAlertService foreground service
 *   handles playback independently of the React Native JS runtime.
 *   CustomMessagingReceiver starts it directly.
 *
 * Flow:
 *   New Order  →  startOrderAlertSound()  →  alert.mp3 loops
 *   Accept     →  stopOrderAlertSound()   →  playback stops
 *   Reject     →  stopOrderAlertSound()   →  playback stops
 *
 * The persisted "Notification Sound" preference in ../config/notificationSound
 * gates startOrderAlertSound() — stopOrderAlertSound() stays unconditional so a
 * mute/un-mute change can never leave audio playing.
 *
 * This module owns AUDIO only. The new-order haptic is fired by
 * notification.service when a push is claimed, and is never gated by the sound
 * preference: sound OFF means a silent alert, not an invisible one.
 */

import { Platform, NativeModules } from 'react-native';
import { isNotificationSoundEnabled } from '../config/notificationSound';

/* ── Types ── */

export interface OrderAlertData {
  orderId: string;
  customerName?: string;
  itemCount?: string;
  total?: string;
}

/* ── Native bridge ── */

interface NativeSoundModule {
  /** Foreground: sound only, no notification */
  startForegroundSound(): void;
  stopForegroundSound(): void;
  /** Background/killed: foreground service with notification */
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
  if (!isNotificationSoundEnabled()) {
    if (__DEV__) {
      console.log('[SOUND] Notification sound is OFF — playback skipped');
    }
    return;
  }

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
    // Use foreground-only audio method: plays alert.mp3 directly via
    // MediaPlayer without starting a foreground service or showing a
    // notification. The modal popup IS the foreground UI.
    NativeSound.startForegroundSound();
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
    NativeSound.stopForegroundSound();
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

/**
 * The order the foreground alert belongs to, or null when nothing started it.
 * Lets multi-device cleanup silence only the resolved order's sound instead of
 * whatever happens to be looping.
 */
export function getActiveAlertOrderId(): string | null {
  return activeOrderId;
}
