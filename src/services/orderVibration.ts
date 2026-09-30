/**
 * Order Vibration Service
 *
 * The single JS owner of the repeating new-order haptic.
 *
 * There are no timers here on purpose. The loop is one native
 * VibrationEffect.createWaveform(…, repeatIndex = 1) owned by
 * android/…/OrderVibration.kt, which repeats in the vibrator itself until
 * somebody cancels it — so a screen unmounting, a re-render or a second pending
 * order can never leave a competing loop behind.
 *
 * Ownership mirrors ../services/sound.service: this module knows *whether JS is
 * alerting*, and src/services/orderAlertSync.ts decides *when that ends*,
 * because that is where the set of pending orders lives.
 *
 * Vibration is never gated by the "Notification Sound" preference. Sound OFF
 * means a silent alert, not an invisible one.
 */

import { Platform, NativeModules } from 'react-native';

interface NativeVibrationBridge {
  startOrderAlertVibration(): void;
  stopOrderAlertVibration(): void;
}

const NativeVibration: NativeVibrationBridge | undefined =
  Platform.OS === 'android'
    ? (NativeModules.NotificationHelper as NativeVibrationBridge | undefined)
    : undefined;

/** The order the JS-owned loop is alerting for, or null when JS is not alerting. */
let vibratingOrderId: string | null = null;

/**
 * Start the repeating haptic for `orderId`.
 *
 * Calling this again for the same order is a no-op, so a delivery retry can not
 * stack loops. A different order re-dispatches the same single loop — that is
 * what keeps the alert repeating when another pending order's notification
 * post took over the motor.
 */
export function startOrderVibration(orderId: string): void {
  if (!orderId) return;

  if (vibratingOrderId === orderId) {
    if (__DEV__) {
      console.log(`[ORDER-VIBE] Already vibrating for ${orderId} — no second loop`);
    }
    return;
  }

  if (Platform.OS !== 'android') {
    vibratingOrderId = orderId;
    return;
  }
  if (!NativeVibration || typeof NativeVibration.startOrderAlertVibration !== 'function') {
    console.log(
      `[ORDER-VIBE] SKIP order=${orderId} — installed build has no ` +
        'startOrderAlertVibration bridge (reinstall the new APK)',
    );
    return;
  }

  vibratingOrderId = orderId;
  try {
    NativeVibration.startOrderAlertVibration();
    if (__DEV__) {
      console.log(`[ORDER-VIBE] Repeating haptic started for ${orderId}`);
    }
  } catch (error) {
    console.log(
      `[ORDER-VIBE] FAIL order=${orderId} bridge call threw:`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Stop the repeating haptic JS owns. Safe to call multiple times, and safe to
 * call when nothing was vibrating.
 *
 * The native controller only silences the motor when its last owner leaves, so
 * a background alert the native service is still ringing is never cut off here.
 */
export function stopOrderVibration(): void {
  const wasVibrating = vibratingOrderId;
  vibratingOrderId = null;

  if (!NativeVibration || typeof NativeVibration.stopOrderAlertVibration !== 'function') {
    return;
  }

  try {
    NativeVibration.stopOrderAlertVibration();
    if (__DEV__) {
      console.log(
        wasVibrating
          ? `[ORDER-VIBE] Repeating haptic stopped (was: ${wasVibrating})`
          : '[ORDER-VIBE] Haptic stop requested — JS was not vibrating',
      );
    }
  } catch (error) {
    console.log(
      '[ORDER-VIBE] FAIL stop bridge call threw:',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** Which order the JS-owned loop belongs to, or null when JS is not alerting. */
export function getVibratingOrderId(): string | null {
  return vibratingOrderId;
}
