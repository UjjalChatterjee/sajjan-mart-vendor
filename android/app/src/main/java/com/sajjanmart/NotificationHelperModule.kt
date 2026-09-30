package com.sajjanmart

import android.app.NotificationManager
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Build
import android.util.Log
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
 *   - Start / stop the repeating new-order haptic (OrderVibration)
 *   - Start / stop the foreground order alert service (loops alert.mp3)
 *   - Dismiss a notification by its deterministic ID
 *   - Emit action / tap events back to JS when the app is alive
 *
 * The killed / background order alert notification is deliberately generic
 * (see OrderAlertService), so this module exposes no order-detail notification
 * builder any more.
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

        /**
         * Carried by the generic order-alert notification's tap intent. It says
         * only "open the Orders screen" — no order id, and therefore nothing
         * sensitive in the notification's PendingIntent either.
         */
        const val EXTRA_OPEN_ORDERS = "open_orders"

        private const val PREFS_NAME = "sajjanmart_notifications"
        private const val KEY_SOUND_ENABLED = "order_alert_sound_enabled"

        /**
         * The notification channel's one-shot buzz pattern.
         *
         * A channel can only vibrate once per post — it cannot loop — so this is
         * NOT the repeating alert. The repeating haptic lives in
         * [OrderVibration.LOOP_PATTERN] and is the single owner of the motor.
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
         * shared by OrderAlertService and the JS cleanup path. Because both use it,
         * cancelling one order's alert can never touch another order's notification
         * or a notification from another app.
         *
         * The live alert posts the generic service notification instead (it names
         * no order), so this id now exists to clear entries an older build left
         * behind and to keep per-order dismissal exact.
         */
        @JvmStatic
        fun notificationIdFor(orderId: String): Int {
            return 0x7FFFFFFF and orderId.hashCode()
        }
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

    /* ── Notification ID ── */

    /* The deterministic id lives in the companion (notificationIdFor) so
       OrderAlertService and the receivers resolve the same id for an order. */

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

    /* ── Repeating haptic (in-app alert) ── */

    /**
     * JS call: NotificationHelper.startOrderAlertVibration()
     *
     * Start — or re-assert — the repeating new-order haptic owned by
     * [OrderVibration]. The loop is a hardware waveform repeat, not a JS timer,
     * and a second call for the same alert cannot create a second loop.
     *
     * Never gated by the sound preference: Sound OFF means a silent alert, not
     * an invisible one.
     */
    @ReactMethod
    fun startOrderAlertVibration() {
        OrderVibration.start(reactApplicationContext, OrderVibration.OWNER_JS)
    }

    /**
     * JS call: NotificationHelper.stopOrderAlertVibration()
     *
     * The JS runtime no longer has a pending alert to vibrate for. Safe to call
     * multiple times, and the motor only stops when the last owner leaves — so
     * this can never silence a background alert the service is still ringing.
     */
    @ReactMethod
    fun stopOrderAlertVibration() {
        OrderVibration.stop(reactApplicationContext, OrderVibration.OWNER_JS)
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

    /* ── Background / killed alert (foreground service with a generic notification) ── */

    /**
     * Start the foreground order alert service (loops alert.mp3 and runs the
     * repeating haptic).
     *
     * JS call: NotificationHelper.startOrderAlert({ orderId })
     *
     * Only the order id crosses the bridge, on purpose: the service's
     * notification is generic ("Sajjan Mart" / "1 New Order"), so customer name,
     * phone, address, amount and items must not travel into an intent that a
     * lock-screen notification could otherwise expose.
     */
    @ReactMethod
    fun startOrderAlert(data: ReadableMap) {
        val orderId = data.getString("orderId") ?: return
        Log.d(TAG, "[ORDER-ALERT] startOrderAlert called from JS for order $orderId")
        OrderAlertService.start(reactApplicationContext, orderId)
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

    /* ── Notification tap (generic order-alert → Orders screen) ── */

    /**
     * Called by MainActivity when the generic order-alert notification is tapped
     * while the app is running. Emits "NotificationOpenOrders" so the JS router
     * can show the Orders screen, then clears the stash so a later
     * getPendingOrdersNavigation() cannot replay the same tap.
     */
    fun emitOrdersNavigationToJS() {
        try {
            if (reactApplicationContext.hasActiveReactInstance()) {
                Log.d(TAG, "[ORDER-TAP] Emitting open-orders navigation to JS")
                reactApplicationContext
                    .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit("NotificationOpenOrders", null)
                MainActivity.pendingOrdersNavigation = false
            }
        } catch (e: Exception) {
            Log.w(TAG, "Could not emit open-orders navigation to JS: ${e.message}")
        }
    }

    /**
     * JS call: NotificationHelper.getPendingOrdersNavigation() → Promise<boolean>.
     *
     * Returns and clears the flag MainActivity stashed from a notification tap.
     * This is the cold-start path: the React context does not exist yet when the
     * intent arrives, so the signal has to be pulled instead of pushed.
     */
    @ReactMethod
    fun getPendingOrdersNavigation(promise: Promise) {
        val pending = MainActivity.pendingOrdersNavigation
        MainActivity.pendingOrdersNavigation = false
        Log.d(TAG, "[ORDER-TAP] getPendingOrdersNavigation → $pending")
        promise.resolve(pending)
    }
}
