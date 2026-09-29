package com.sajjanmart

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Build
import android.os.VibrationEffect
import android.os.VibrationAttributes
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import androidx.core.app.NotificationCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * Native module exposed to JS as "NotificationHelper".
 *
 * Responsibilities:
 *   - Build and display Android notifications with ACCEPT / REJECT action buttons
 *   - Dismiss a notification by its deterministic ID
 *   - Start / stop the foreground order alert service (loops alert.mp3)
 *   - Emit action events back to JS when the app is alive
 */
class NotificationHelperModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    // Direct MediaPlayer for foreground-only sound (no notification)
    private var foregroundPlayer: MediaPlayer? = null
    private var foregroundPlaying = false

    // Foreground loudness handling — mirrors OrderAlertService: temporarily raise
    // STREAM_ALARM to max and hold AUDIOFOCUS_GAIN for the alert duration, then
    // restore the previous volume and abandon focus when the alert stops.
    private var foregroundAudioManager: AudioManager? = null
    private var foregroundFocusRequest: AudioFocusRequest? = null
    private var foregroundFocusListener: AudioManager.OnAudioFocusChangeListener? = null
    private var foregroundPrevVolume = -1

    companion object {
        private const val TAG = "NotificationHelper"
        const val MODULE_NAME = "NotificationHelper"
        const val CHANNEL_ID = "sajjanmart_orders"
        const val CHANNEL_NAME = "Sajjan Mart Orders"
        const val CHANNEL_DESC = "Alerts for new incoming orders"
        const val ACTION_ACCEPT = "com.sajjanmart.ORDER_ACCEPT"
        const val ACTION_REJECT = "com.sajjanmart.ORDER_REJECT"
        const val EXTRA_ORDER_ID = "order_id"
        const val EXTRA_ACTION = "order_action"

        private const val PREFS_NAME = "sajjanmart_notifications"
        private const val KEY_SOUND_ENABLED = "order_alert_sound_enabled"

        /**
         * The single new-order haptic pattern.
         *
         * Both alert paths use it — the notification channel (background / killed)
         * and vibrateOrderAlert() (in-app modal, where no notification is posted) —
         * so an order alert buzzes the same way whichever path delivered it.
         * Vibration is never gated by the sound preference.
         */
        val ORDER_ALERT_VIBRATION_PATTERN = longArrayOf(0, 300, 200, 300, 200, 300)

        /**
         * Read the notification-sound switch that the Settings screen persists here
         * in SharedPreferences (see src/config/notificationSound.ts).
         *
         * Defaults to enabled until the user turns it off, so a fresh install or a
         * push handled before the bundle ever ran still sounds.
         */
        @JvmStatic
        fun isNotificationSoundEnabled(context: Context): Boolean =
            context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .getBoolean(KEY_SOUND_ENABLED, true)

        @Volatile
        var instance: NotificationHelperModule? = null
            private set

        /**
         * Deterministic notification ID for an order — the single source of truth
         * shared by the JS-posted order notification and OrderAlertService's
         * foreground notification. Because both paths use it, one notification
         * exists per order and cancelling it can never touch another order's
         * notification or a notification from another app.
         */
        @JvmStatic
        fun notificationIdFor(orderId: String): Int {
            return 0x7FFFFFFF and orderId.hashCode()
        }

        /**
         * PendingIntent request code for one order's ACCEPT / REJECT button.
         *
         * Mixing with multiplication, not `or`: `orderId.hashCode() or 0x10000`
         * left two orders whose hashes differed only inside those bits with the
         * SAME code, and with FLAG_UPDATE_CURRENT the second notification
         * silently rewrote the first button's target order.
         */
        @JvmStatic
        fun actionRequestCode(orderId: String, action: String): Int =
            0x7FFFFFFF and (31 * orderId.hashCode() + if (action == ACTION_REJECT) 7919 else 104729)
    }

    init {
        instance = this
    }

    override fun invalidate() {
        super.invalidate()
        if (instance == this) {
            instance = null
        }
    }

    override fun getName(): String = MODULE_NAME

    /* ── Channel ── */

    /**
     * Delegate channel creation to OrderAlertService.ensureNotificationChannel()
     * — the single source of truth for the urgent order-alert channel.
     * Creating the channel from two places with different configs would be
     * unpredictable: whichever runs first wins and the second is ignored.
     */
    private fun ensureChannel(): String {
        OrderAlertService.ensureNotificationChannel(reactApplicationContext)
        return CHANNEL_ID
    }

    /* ── Notification ID ── */

    /* The deterministic id lives in the companion (notificationIdFor) so
       OrderAlertService and the receivers resolve the same id for an order. */

    /* ── Build & show ── */

    /**
     * Show a notification with ACCEPT / REJECT action buttons.
     *
     * JS call:
     *   NotificationHelper.showOrderNotification({
     *     orderId, customerName, itemCount, total
     *   })
     */
    @ReactMethod
    fun showOrderNotification(data: ReadableMap) {
        try {
            val ctx = reactApplicationContext
            val orderId = data.getString("orderId") ?: return
            val orderNumber = data.getString("orderNumber") ?: orderId
            val customerName = data.getString("customerName") ?: "Customer"
            val customerPhone = data.getString("customerPhone") ?: ""
            val itemCount = data.getString("itemCount") ?: "?"
            val total = data.getString("total") ?: "0"
            val paymentMethod = data.getString("paymentMethod") ?: ""
            val address = data.getString("address") ?: ""

            val channelId = ensureChannel()
            val notifId = notificationIdFor(orderId)

            // ── PendingIntents for actions ──
            val acceptIntent = createActionIntent(ctx, ACTION_ACCEPT, orderId)
            val rejectIntent = createActionIntent(ctx, ACTION_REJECT, orderId)

            // ── Tap intent — opens the app ──
            val tapIntent = Intent(ctx, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
                putExtra(EXTRA_ORDER_ID, orderId)
            }
            val tapPending = PendingIntent.getActivity(
                ctx, notifId, tapIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )

            val paymentLabel = OrderAlertService.friendlyPaymentMethod(paymentMethod)

            val bigText = buildString {
                append("Order Number: #$orderNumber\n")
                if (customerName.isNotEmpty()) append("Customer: $customerName\n")
                if (customerPhone.isNotEmpty()) append("Phone: $customerPhone\n")
                if (total.isNotEmpty()) append("Total Amount: ₹$total\n")
                if (paymentMethod.isNotEmpty()) append("Payment Method: $paymentLabel\n")
                append("Items: $itemCount\n")
                if (address.isNotEmpty()) append("\nDelivery Address:\n$address")
            }.trimEnd()

            val contentText = buildString {
                append("Order #$orderNumber")
                if (customerName.isNotEmpty()) append(" • $customerName")
                if (total.isNotEmpty()) append(" • ₹$total")
                if (paymentMethod.isNotEmpty()) append(" ($paymentLabel)")
            }

            // ── Build notification ──
            val notification = NotificationCompat.Builder(ctx, channelId)
                .setSmallIcon(android.R.drawable.ic_dialog_alert)
                .setColor(0xFF16A34A.toInt())
                .setColorized(true)
                .setContentTitle("NEW ORDER")
                .setSubText("#$orderNumber")
                .setContentText(contentText)
                .setStyle(
                    NotificationCompat.BigTextStyle()
                        .setBigContentTitle("NEW ORDER")
                        .setSummaryText("#$orderNumber")
                        .bigText(bigText)
                )
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setAutoCancel(false)
                .setOngoing(true)
                .setContentIntent(tapPending)
                .addAction(android.R.drawable.ic_menu_send, "ACCEPT", acceptIntent)
                .addAction(android.R.drawable.ic_menu_close_clear_cancel, "REJECT", rejectIntent)
                .build()

            val nm = ctx.getSystemService(NotificationManager::class.java)
            nm.notify(notifId, notification)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to show notification", e)
        }
    }

    /* ── Dismiss ── */

    /**
     * Dismiss a notification by order ID.
     *
     * JS call: NotificationHelper.dismissNotification(orderId)
     */
    @ReactMethod
    fun dismissNotification(orderId: String) {
        val ctx = reactApplicationContext
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.cancel(notificationIdFor(orderId))
    }

    /* ── Alert Sound (Foreground: sound only, no notification) ── */

    /**
     * JS call: NotificationHelper.setNotificationSoundEnabled(true | false)
     *
     * Persists the "Notification Sound" preference. SharedPreferences is the one
     * store for it — the Settings screen writes it here, JS reads it back through
     * getNotificationSoundEnabled(), and the native-only alert path
     * (CustomMessagingReceiver → OrderAlertService), which runs without the JS
     * bundle, honours it straight from this file. Affects audio only:
     * notifications, vibration and ACCEPT / REJECT are untouched.
     */
    @ReactMethod
    fun setNotificationSoundEnabled(enabled: Boolean) {
        reactApplicationContext
            .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_SOUND_ENABLED, enabled)
            .apply()
        Log.d(TAG, "[ORDER-ALERT] Notification sound ${if (enabled) "enabled" else "muted"} by JS")
    }

    /**
     * JS call: NotificationHelper.getNotificationSoundEnabled() → Promise<Boolean>
     *
     * The persisted value, read from the same SharedPreferences file the native
     * alert path uses. Never a second copy, so the two runtimes cannot drift.
     */
    @ReactMethod
    fun getNotificationSoundEnabled(promise: Promise) {
        promise.resolve(isNotificationSoundEnabled(reactApplicationContext))
    }

    /**
     * JS call: NotificationHelper.vibrateOrderAlert()
     *
     * One haptic burst for the in-app new-order alert. While the app is in the
     * foreground no system notification is posted (the modal IS the UI), so the
     * channel-level vibration never runs — this is the only vibration source for
     * that path, which keeps exactly one buzz per alert.
     *
     * The burst always carries an *alarm* usage: VibrationAttributes on API 31+,
     * AudioAttributes on API 26–30. A bare Vibrator.vibrate(effect) runs with
     * *notification* usage, which the platform and OEM skins (MIUI and friends)
     * drop whenever the ringtone is silent or Do Not Disturb is on — an order
     * alert must not be silenced by that. Never gated by the sound
     * preference: a muted alert is a silent alert, not an invisible one.
     *
     * [ORDER-VIBE] logs are the field diagnostic for "the popup appeared but the
     * phone never buzzed" — they name the state of every hop.
     */
    @ReactMethod
    fun vibrateOrderAlert() {
        val ctx = reactApplicationContext
        val sdk = Build.VERSION.SDK_INT
        val manager = ctx.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
        val vibrator: Vibrator? = manager?.defaultVibrator
            ?: ctx.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator

        val nm = ctx.getSystemService(NotificationManager::class.java)
        val am = ctx.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
        val ringerMode = when (am?.ringerMode) {
            AudioManager.RINGER_MODE_NORMAL -> "normal"
            AudioManager.RINGER_MODE_VIBRATE -> "vibrate"
            AudioManager.RINGER_MODE_SILENT -> "silent"
            else -> "unknown(${am?.ringerMode})"
        }
        Log.i(
            TAG,
            "[ORDER-VIBE] request sdk=$sdk hasVibrator=${vibrator?.hasVibrator() == true} " +
                "ringerMode=$ringerMode interruptionFilter=${nm.currentInterruptionFilter} " +
                "dndPolicyAccess=${nm.isNotificationPolicyAccessGranted} " +
                "channelVibrates=${channelVibrationState(ctx)}",
        )

        if (vibrator == null || !vibrator.hasVibrator()) {
            Log.e(TAG, "[ORDER-VIBE] STOPPED HERE — no vibrator handle for sdk=$sdk")
            return
        }
        val motor: Vibrator = vibrator

        val effect = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            VibrationEffect.createWaveform(ORDER_ALERT_VIBRATION_PATTERN, -1)
        } else {
            null
        }

        try {
            if (sdk >= Build.VERSION_CODES.S && effect != null) {
                motor.vibrate(
                    effect,
                    VibrationAttributes.createForUsage(VibrationAttributes.USAGE_ALARM),
                )
                Log.i(TAG, "[ORDER-VIBE] dispatched with VibrationAttributes USAGE_ALARM")
            } else if (effect != null) {
                // API 26–30 (the field device is 29): the bare vibrate(effect) runs
                // as a *notification*, which MIUI and AOSP both drop when the
                // ringer is silent. This overload carries the alarm usage instead.
                motor.vibrate(
                    effect,
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build(),
                )
                Log.i(TAG, "[ORDER-VIBE] dispatched with AudioAttributes USAGE_ALARM")
            } else {
                // API 24/25 has no VibrationEffect; the waveform overload there is the
                // only way to reuse the shared pattern.
                motor.vibrate(ORDER_ALERT_VIBRATION_PATTERN, -1)
                Log.i(TAG, "[ORDER-VIBE] dispatched via legacy waveform")
            }
        } catch (e: Exception) {
            Log.e(TAG, "[ORDER-VIBE] STOPPED HERE — vibrate() threw: ${e.message}", e)
            return
        }

        // The motor state is not queryable on current SDKs (Vibrator.isVibrating()
        // was removed), so this second line is the post-dispatch environment sample:
        // separating "we never asked" (no dispatch line at all) from "we asked and
        // the OS/OEM dropped it" (dispatch line, then a silent ringer here).
        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
            Log.i(
                TAG,
                "[ORDER-VIBE] 250ms after dispatch ringerMode=$ringerMode " +
                    "interruptionFilter=${nm.currentInterruptionFilter} " +
                    "channelVibrates=${channelVibrationState(ctx)}",
            )
        }, 250)
    }

    /** Whether the order-alert channel is still configured to vibrate — a channel
     *  created by an older build keeps its pattern across installs, so this is
     *  logged rather than assumed. */
    private fun channelVibrationState(context: Context): String {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return "n/a(pre-O)"
        val channel = context.getSystemService(NotificationManager::class.java)
            .getNotificationChannel(CHANNEL_ID) ?: return "missing"
        return "enabled=${channel.shouldVibrate()} pattern=${channel.vibrationPattern?.joinToString()}"
    }

    /* ── API base URL (native-only paths) ── */

    /**
     * JS call: NotificationHelper.setApiBaseUrl(Env.API_BASE_URL)
     *
     * Publishes the address the JS runtime is using into SharedPreferences so the
     * killed-app ACCEPT / REJECT path (NativeOrderApiService, which runs with no
     * JS bundle) calls the same server. One store, same rule as the sound switch:
     * Kotlin holds no URL of its own.
     */
    @ReactMethod
    fun setApiBaseUrl(url: String?) {
        ApiBaseUrlStore.save(reactApplicationContext, url)
    }

    /**
     * JS call: NotificationHelper.getApiBaseUrl() → Promise<String | null>
     *
     * Diagnostic read: what the native-only paths will actually call.
     */
    @ReactMethod
    fun getApiBaseUrl(promise: Promise) {
        promise.resolve(ApiBaseUrlStore.read(reactApplicationContext))
    }

    /**
     * Play alert.mp3 directly via MediaPlayer — NO foreground service,
     * NO notification. Used by the in-app modal when the app is in
     * the foreground so no system notification appears over the popup.
     *
     * JS call: NotificationHelper.startForegroundSound()
     */
    @ReactMethod
    fun startForegroundSound() {
        if (!isNotificationSoundEnabled(reactApplicationContext)) {
            Log.d(TAG, "[ORDER-ALERT] Notification sound muted — foreground playback skipped")
            return
        }
        if (foregroundPlaying) {
            Log.d(TAG, "[ORDER-ALERT] Foreground sound already playing, skipping")
            return
        }
        foregroundPlaying = true
        try {
            val resId = reactApplicationContext.resources.getIdentifier(
                "alert", "raw", reactApplicationContext.packageName
            )
            if (resId == 0) {
                Log.e(TAG, "alert.mp3 not found in res/raw")
                foregroundPlaying = false
                return
            }

            captureAndRaiseAlarmVolume()
            requestForegroundAudioFocus()

            foregroundPlayer = MediaPlayer().apply {
                setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build()
                )
                setDataSource(
                    reactApplicationContext,
                    android.net.Uri.parse("android.resource://${reactApplicationContext.packageName}/$resId")
                )
                isLooping = true
                setOnPreparedListener {
                    if (foregroundPlayer != null) {
                        start()
                        Log.d(TAG, "[ORDER-ALERT] Foreground sound started")
                    }
                }
                setOnErrorListener { _, what, extra ->
                    Log.e(TAG, "Foreground sound error: what=$what extra=$extra")
                    foregroundPlayer = null
                    foregroundPlaying = false
                    restoreForegroundVolume()
                    abandonForegroundAudioFocus()
                    false
                }
                prepareAsync()
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start foreground sound", e)
            foregroundPlaying = false
            restoreForegroundVolume()
            abandonForegroundAudioFocus()
        }
    }

    /**
     * Stop foreground alert playback immediately, restore the pre-alert alarm
     * volume and release audio focus. Safe to call multiple times.
     */
    @ReactMethod
    fun stopForegroundSound() {
        stopForegroundPlayback()
    }

    private fun stopForegroundPlayback() {
        val player = foregroundPlayer
        foregroundPlayer = null
        foregroundPlaying = false
        try {
            player?.apply {
                try { if (isPlaying) stop() } catch (_: IllegalStateException) {}
                release()
            }
            Log.d(TAG, "[ORDER-ALERT] Foreground sound stopped")
        } catch (e: Exception) {
            Log.e(TAG, "Error stopping foreground sound", e)
        }
        restoreForegroundVolume()
        abandonForegroundAudioFocus()
    }

    /* ── Foreground loudness helpers (same approach as OrderAlertService) ── */

    /** Capture the current STREAM_ALARM level and temporarily raise it to the
     *  stream maximum so a muted/low-volume device still rings. The captured
     *  level is restored by restoreForegroundVolume() when the alert stops. */
    private fun captureAndRaiseAlarmVolume() {
        foregroundAudioManager =
            reactApplicationContext.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
        val am = foregroundAudioManager ?: return
        try {
            foregroundPrevVolume = am.getStreamVolume(AudioManager.STREAM_ALARM)
            val max = am.getStreamMaxVolume(AudioManager.STREAM_ALARM)
            if (foregroundPrevVolume < max) {
                am.setStreamVolume(AudioManager.STREAM_ALARM, max, AudioManager.FLAG_SHOW_UI)
                Log.d(TAG, "[ORDER-ALERT] Foreground: bumped STREAM_ALARM $foregroundPrevVolume → $max")
            }
        } catch (e: SecurityException) {
            Log.w(TAG, "Cannot temporarily raise alarm volume: ${e.message}")
        }
    }

    private fun restoreForegroundVolume() {
        val am = foregroundAudioManager ?: return
        if (foregroundPrevVolume < 0) return
        try {
            if (am.getStreamVolume(AudioManager.STREAM_ALARM) != foregroundPrevVolume) {
                am.setStreamVolume(AudioManager.STREAM_ALARM, foregroundPrevVolume, AudioManager.FLAG_SHOW_UI)
                Log.d(TAG, "[ORDER-ALERT] Foreground: restored STREAM_ALARM to $foregroundPrevVolume")
            }
        } catch (e: SecurityException) {
            Log.w(TAG, "Cannot restore alarm volume: ${e.message}")
        }
    }

    /** AUDIOFOCUS_GAIN with USAGE_ALARM attributes, mirroring
     *  OrderAlertService.requestAudioFocus(). On focus loss the alert stops
     *  and cleans up so we do not fight another audio owner (e.g. a call). */
    private fun requestForegroundAudioFocus() {
        val am = foregroundAudioManager ?: return
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                if (foregroundFocusRequest != null) return
                val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(
                        AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_ALARM)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .build()
                    )
                    .setOnAudioFocusChangeListener { focusChange ->
                        handleForegroundFocusChange(focusChange)
                    }
                    .build()
                if (am.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
                    foregroundFocusRequest = request
                    Log.d(TAG, "[ORDER-ALERT] Foreground: audio focus granted (AUDIOFOCUS_GAIN)")
                } else {
                    Log.w(TAG, "[ORDER-ALERT] Foreground: audio focus request not granted")
                }
            } else {
                if (foregroundFocusListener != null) return
                val listener = AudioManager.OnAudioFocusChangeListener { focusChange ->
                    handleForegroundFocusChange(focusChange)
                }
                if (am.requestAudioFocus(
                        listener,
                        AudioManager.STREAM_MUSIC,
                        AudioManager.AUDIOFOCUS_GAIN,
                    ) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
                ) {
                    foregroundFocusListener = listener
                    Log.d(TAG, "[ORDER-ALERT] Foreground: legacy audio focus granted (AUDIOFOCUS_GAIN)")
                } else {
                    Log.w(TAG, "[ORDER-ALERT] Foreground: audio focus request not granted")
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "[ORDER-ALERT] Foreground: audio focus request failed: ${e.message}")
            foregroundFocusRequest = null
            foregroundFocusListener = null
        }
    }

    private fun handleForegroundFocusChange(focusChange: Int) {
        when (focusChange) {
            AudioManager.AUDIOFOCUS_LOSS,
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
            -> {
                Log.w(TAG, "[ORDER-ALERT] Foreground: lost audio focus ($focusChange) — stopping")
                stopForegroundPlayback()
            }
            else -> {}
        }
    }

    private fun abandonForegroundAudioFocus() {
        val am = foregroundAudioManager ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            foregroundFocusRequest?.let {
                try { am.abandonAudioFocusRequest(it) } catch (_: Exception) {}
            }
            foregroundFocusRequest = null
        } else {
            foregroundFocusListener?.let {
                try { am.abandonAudioFocus(it) } catch (_: Exception) {}
            }
            foregroundFocusListener = null
        }
    }

    /* ── Alert Sound (Background/Killed: foreground service with notification) ── */

    /**
     * Start the foreground order alert service (loops alert.mp3).
     * Shows a persistent notification with ACCEPT / REJECT actions.
     * Used for background/killed states only.
     *
     * JS call:
     *   NotificationHelper.startOrderAlert({
     *     orderId, orderNumber, customerName, customerPhone,
     *     address, total, paymentMethod, paymentStatus, items
     *   })
     */
    @ReactMethod
    fun startOrderAlert(data: ReadableMap) {
        Log.d(TAG, "[ORDER-ALERT] startOrderAlert called from JS")

        val orderId = data.getString("orderId") ?: return
        val orderNumber = data.getString("orderNumber") ?: orderId
        val customerName = data.getString("customerName") ?: ""
        val customerPhone = data.getString("customerPhone") ?: ""
        val address = data.getString("address") ?: ""
        val total = data.getString("total") ?: ""
        val paymentMethod = data.getString("paymentMethod") ?: ""
        val paymentStatus = data.getString("paymentStatus") ?: ""
        val itemsJson = data.getString("items") ?: "[]"

        OrderAlertService.start(
            reactApplicationContext,
            orderId, orderNumber, customerName, customerPhone,
            address, total, paymentMethod, paymentStatus, itemsJson,
        )
    }

    /**
     * Stop the order alert service and release audio.
     * Safe to call multiple times.
     */
    @ReactMethod
    fun stopOrderAlert() {
        Log.d(TAG, "[ORDER-ALERT] stopOrderAlert called from JS")
        OrderAlertService.stop(reactApplicationContext)
    }

    /* ── Emit action to JS ── */

    /**
     * True only when a JS runtime is alive RIGHT NOW and can receive an event.
     *
     * The receiver must not trust `instance != null`: that only says the module
     * was constructed once, which stays true after the React host has been torn
     * down (or while it never came up in a process revived by a notification
     * tap). Trusting it dropped ACCEPT / REJECT taps with no native fallback.
     */
    fun canEmitToJS(): Boolean =
        try {
            reactApplicationContext.hasActiveReactInstance()
        } catch (e: Exception) {
            false
        }

    /**
     * Called by NotificationActionReceiver when the app is alive.
     * Emits a "NotificationAction" event to JS.
     *
     * Returns false when nothing was emitted, so the caller can fall back to the
     * native API service instead of losing the tap.
     */
    fun emitActionToJS(action: String, orderId: String): Boolean {
        try {
            if (!reactApplicationContext.hasActiveReactInstance()) {
                Log.w(TAG, "[ORDER-ACTION] No active JS runtime — action not emitted")
                return false
            }
            Log.d(TAG, "[ORDER-ACTION] Emitting to JS: $action for order $orderId")
            val params = com.facebook.react.bridge.Arguments.createMap().apply {
                putString("action", action)
                putString("orderId", orderId)
            }
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("NotificationAction", params)
            return true
        } catch (e: Exception) {
            Log.w(TAG, "Could not emit action to JS: ${e.message}")
            return false
        }
    }

    /* ── Notification tap (NEW_ORDER notification click → JS) ── */

    /**
     * Called by MainActivity when a NEW_ORDER notification is tapped while the
     * app is running. Emits "NotificationTap" to JS and clears the stash so a
     * later getTappedOrderId() cannot re-open the same order.
     */
    fun emitTapToJS(orderId: String) {
        try {
            if (reactApplicationContext.hasActiveReactInstance()) {
                Log.d(TAG, "[ORDER-TAP] Emitting tap to JS for order $orderId")
                val params = com.facebook.react.bridge.Arguments.createMap().apply {
                    putString("orderId", orderId)
                }
                reactApplicationContext
                    .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit("NotificationTap", params)
                MainActivity.pendingTapOrderId = null
            }
        } catch (e: Exception) {
            Log.w(TAG, "Could not emit tap to JS: ${e.message}")
        }
    }

    /**
     * JS call: NotificationHelper.getTappedOrderId() → Promise<string | null>.
     * Returns and clears the order_id stashed by MainActivity from a
     * NEW_ORDER notification tap (cold start path).
     */
    @ReactMethod
    fun getTappedOrderId(promise: Promise) {
        val orderId = MainActivity.pendingTapOrderId
        MainActivity.pendingTapOrderId = null
        Log.d(TAG, "[ORDER-TAP] getTappedOrderId → ${orderId ?: "null"}")
        promise.resolve(orderId)
    }

    /* ── Helpers ── */

    private fun createActionIntent(ctx: Context, action: String, orderId: String, orderNumber: String = orderId): PendingIntent {
        val intent = Intent(ctx, NotificationActionReceiver::class.java).apply {
            this.action = action
            putExtra(EXTRA_ORDER_ID, orderId)
            putExtra(EXTRA_ACTION, action)
            putExtra("orderNumber", orderNumber)
        }
        // Unique per (order, action) — see actionRequestCode.
        val requestCode = actionRequestCode(orderId, action)
        return PendingIntent.getBroadcast(
            ctx, requestCode, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }
}
