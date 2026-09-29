/**
 * Notification Sound Switch
 *
 * THE single place to turn the new-order alert sound on or off.
 *
 *   ENABLE_NOTIFICATION_SOUND = true   → alert.mp3 plays for a new order
 *   ENABLE_NOTIFICATION_SOUND = false  → no sound
 *
 * This flag only controls AUDIO. FCM delivery, the notification itself,
 * vibration, the in-app modal and Accept / Reject all keep working either way.
 *
 * Both playback paths are covered:
 *   Foreground     → sound.service.ts refuses to start the native MediaPlayer.
 *   Background /
 *   killed         → the value is mirrored into native storage (SharedPreferences)
 *                    by syncNotificationSoundFlag(), and OrderAlertService skips
 *                    playback while still showing its notification.
 */

import { NativeModules, Platform } from 'react-native';

/** Switch the new-order notification sound ON or OFF here. */
const ENABLE_NOTIFICATION_SOUND: boolean = false;

/** Whether the order-alert sound is currently allowed to play. */
export function isNotificationSoundEnabled(): boolean {
  return ENABLE_NOTIFICATION_SOUND;
}

/**
 * Publish the flag to the native layer.
 *
 * Must be called as early as possible in every JS runtime start-up (see
 * index.js) so that a later background / killed NEW_ORDER push — which is
 * handled entirely by native code, without this bundle re-running — mutes or
 * un-mutes correctly. Before the first call native falls back to its own
 * default (sound enabled).
 */
export function syncNotificationSoundFlag(): void {
  if (Platform.OS !== 'android') {
    return;
  }

  const nativeBridge = NativeModules.NotificationHelper as
    | { setNotificationSoundEnabled: (enabled: boolean) => void }
    | undefined;

  if (!nativeBridge?.setNotificationSoundEnabled) {
    if (__DEV__) {
      console.log('[SOUND] Native bridge unavailable — sound flag not synced');
    }
    return;
  }

  try {
    nativeBridge.setNotificationSoundEnabled(ENABLE_NOTIFICATION_SOUND);
    if (__DEV__) {
      console.log(
        `[SOUND] Notification sound flag synced to native: ${
          ENABLE_NOTIFICATION_SOUND ? 'ON' : 'OFF'
        }`,
      );
    }
  } catch (error) {
    console.warn(
      '[SOUND] Failed to sync notification sound flag:',
      error instanceof Error ? error.message : String(error),
    );
  }
}
