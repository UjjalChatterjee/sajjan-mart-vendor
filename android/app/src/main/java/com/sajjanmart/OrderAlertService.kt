package com.sajjanmart

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.ComponentName
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import org.json.JSONArray
import org.json.JSONObject

/**
 * Foreground Service that plays alert.mp3 in a continuous loop.
 *
 * The persistent notification shows full order details with
 * REJECT / ACCEPT actions so the store staff can act directly
 * from the notification even when the app is in the background or killed.
 *
 * This service is fully native — no React Native dependency.
 * It is started by:
 *   - CustomMessagingReceiver (background/killed FCM)
 *   - NotificationHelperModule (from JS foreground)
 */
class OrderAlertService : Service() {

    companion object {
        private const val TAG = "OrderAlertService"

        /**
         * Legacy fixed notification id kept only so a service notification posted
         * by an older build can still be cleared. New alerts use
         * NotificationHelperModule.notificationIdFor(orderId) — the same id the JS
         * path uses — so a single ORDER_STATUS_UPDATED can dismiss exactly the
         * order it refers to.
         */
        const val NOTIFICATION_ID = 9999
        private const val ACTION_STOP = "com.sajjanmart.ALERT_STOP"

        // Intent extras
        private const val EXTRA_ORDER_ID      = "order_id"
        private const val EXTRA_ORDER_NUMBER  = "order_number"
        private const val EXTRA_CUSTOMER_NAME = "customer_name"
        private const val EXTRA_CUSTOMER_PHONE = "customer_phone"
        private const val EXTRA_ADDRESS       = "address"
        private const val EXTRA_TOTAL         = "total"
        private const val EXTRA_PAYMENT_METHOD = "payment_method"
        private const val EXTRA_PAYMENT_STATUS = "payment_status"
        private const val EXTRA_ITEMS_JSON    = "items_json"
        private const val EXTRA_ITEM_COUNT    = "item_count"

        /** Mutable shared audio-state snapshot used only as a best-effort restore path when
         *  OrderAlertService.stop(context) is called without a live instance (for example after the
         *  service already exited in a racing stop path). This is intentionally a separate path from
         *  the primary restore inside stopPlayback()/onDestroy(), which runs on the live instance. */
        @Volatile
        private var sharedPrevVolume: Int = 0
        @Volatile
        private var sharedStreamMax: Int = 0
        @Volatile
        private var sharedStreamType: Int = AudioManager.STREAM_ALARM

        /** True once an alert has actually captured the pre-alert stream state, so a
         *  restore can never write a stale default volume back to the alarm stream. */
        @Volatile
        private var sharedStreamStateCaptured: Boolean = false

        @JvmStatic
        private fun restoreSharedStreamState(context: Context) {
            if (!sharedStreamStateCaptured) return
            sharedStreamStateCaptured = false
            if (sharedStreamType != AudioManager.STREAM_ALARM) return
            if (sharedPrevVolume < 0) return
            try {
                val am = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
                val current = am.getStreamVolume(sharedStreamType)
                if (current != sharedPrevVolume) {
                    am.setStreamVolume(
                        sharedStreamType,
                        sharedPrevVolume,
                        AudioManager.FLAG_SHOW_UI,
                    )
                }
            } catch (_: Exception) {}
        }

        /** Start the order alert service with full order details.
         *  Safe to call multiple times — duplicate starts are ignored by the
         *  isPlaying guard in startPlayback(). */
        fun start(
            context: Context,
            orderId: String,
            orderNumber: String = orderId,
            customerName: String = "",
            customerPhone: String = "",
            address: String = "",
            total: String = "",
            paymentMethod: String = "",
            paymentStatus: String = "",
            itemsJson: String = "[]",
            itemCount: String = "",
        ) {
            // An order this device already decided must never ring again — this
            // covers the status push arriving before (or instead of) the NEW_ORDER.
            if (OrderDecisionStore.isResolved(context, orderId)) {
                Log.d(TAG, "[ORDER-ALERT] Order $orderId already resolved — alert skipped")
                return
            }

            val intent = Intent(context, OrderAlertService::class.java).apply {
                putExtra(EXTRA_ORDER_ID,       orderId)
                putExtra(EXTRA_ORDER_NUMBER,   orderNumber)
                putExtra(EXTRA_CUSTOMER_NAME,  customerName)
                putExtra(EXTRA_CUSTOMER_PHONE, customerPhone)
                putExtra(EXTRA_ADDRESS,        address)
                putExtra(EXTRA_TOTAL,          total)
                putExtra(EXTRA_PAYMENT_METHOD, paymentMethod)
                putExtra(EXTRA_PAYMENT_STATUS, paymentStatus)
                putExtra(EXTRA_ITEMS_JSON,     itemsJson)
                putExtra(EXTRA_ITEM_COUNT,     itemCount)
            }
            context.startForegroundService(intent)
        }

        @Volatile
        private var instance: OrderAlertService? = null

        /** The order the single live alert belongs to, for targeted dismissal from
         *  a receiver (which has no service handle of its own). */
        @Volatile
        @JvmStatic
        var activeOrderId: String? = null
            private set

        /**
         * Resolve an order that was decided elsewhere (ORDER_STATUS_UPDATED) or
         * by this device.
         *
         * Stops the looping siren only when this order owns it, then cancels
         * exactly this order's notification id. Another order's alert is never
         * touched, so a multi-order tray keeps its pending entries.
         */
        @JvmStatic
        fun handleOrderResolved(context: Context, orderId: String) {
            if (orderId.isBlank() || orderId == "unknown") return

            val ownsAlert = activeOrderId == orderId
            if (ownsAlert) {
                stop(context)
            }

            try {
                val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                nm.cancel(NotificationHelperModule.notificationIdFor(orderId))
                if (ownsAlert) {
                    // Only ours: never cancel another app's or another alert's entry.
                    nm.cancel(NOTIFICATION_ID)
                }
                Log.d(TAG, "[ORDER-ALERT] Resolved order $orderId (ownsAlert=$ownsAlert)")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to cancel notification for resolved order $orderId", e)
            }
        }

        /**
         * Silence the siren for an order WITHOUT cancelling its notification.
         *
         * Used the instant a notification action button is tapped: the loop must
         * stop on the fingertip, but the order has not been decided yet. If the
         * backend call then fails, the notification (with its working ACCEPT /
         * REJECT buttons) is still in the tray, so the alert stays recoverable
         * instead of vanishing on an unconfirmed decision.
         *
         * Only the order that owns the live alert can silence it — another
         * pending order keeps ringing.
         */
        @JvmStatic
        fun stopSoundKeepNotification(context: Context, orderId: String) {
            if (orderId.isBlank() || orderId == "unknown") return
            if (activeOrderId != orderId) {
                Log.d(TAG, "[ORDER-ALERT] Order $orderId does not own the siren — sound left running")
                return
            }

            instance?.stopPlayback()
            activeOrderId = null
            // stopService → onDestroy → stopForeground(DETACH): the looping audio
            // and the foreground-service state end, the notification survives.
            try {
                context.stopService(Intent(context, OrderAlertService::class.java))
            } catch (e: Exception) {
                Log.w(TAG, "[ORDER-ALERT] Could not stop the service cleanly: ${e.message}")
            }
            restoreSharedStreamState(context)
            Log.d(TAG, "[ORDER-ALERT] Siren silenced for $orderId, notification kept")
        }

        /** Stop the order alert service and release audio immediately.
         *  Safe to call multiple times from any thread or receiver. */
        @JvmStatic
        fun stop(context: Context) {
            // Immediate in-memory stop for 0ms latency on ACCEPT/REJECT
            instance?.stopPlayback()
            activeOrderId = null

            try {
                val stopIntent = Intent(context, OrderAlertService::class.java).apply {
                    action = ACTION_STOP
                }
                context.startService(stopIntent)
            } catch (_: Exception) {}

            try {
                context.stopService(Intent(context, OrderAlertService::class.java))
            } catch (_: Exception) {}

            // Best-effort cleanup for cases where stop() was called without a live instance
            // (for example, duplicate-stop calls after the service already exited).
            restoreSharedStreamState(context)
        }

        /** Set a snapshot of the current stream volume so stop(context) can restore it even
         *  when called without a live instance. Called from startPlayback() on the live instance
         *  right before the temporary bump so the snapshot reflects the real pre-alert level. */
        private fun snapshotSharedStreamState(streamType: Int, prevVolume: Int, maxVolume: Int) {
            sharedStreamType = streamType
            sharedPrevVolume = prevVolume
            sharedStreamMax = maxVolume
            sharedStreamStateCaptured = true
        }

        /** Map raw FCM paymentMethod values to human-readable labels.
         *   "cod"       -> "Cash on Delivery"
         *   "online"    -> "Online Payment"
         *   "upi"       -> "UPI"
         *  Package-level accessible so NotificationHelperModule can call it as
         *  OrderAlertService.friendlyPaymentMethod(...). */
        @JvmStatic
        fun friendlyPaymentMethod(raw: String): String = when (raw.lowercase().trim()) {
            "cod"        -> "Cash on Delivery"
            "online"     -> "Online Payment"
            "upi"        -> "UPI"
            "card"       -> "Card"
            "netbanking" -> "Net Banking"
            "wallet"     -> "Wallet"
            else         -> raw.replaceFirstChar { it.uppercase() }
        }

        /**
         * Single source of truth for the order alert notification channel.
         * Both OrderAlertService and NotificationHelperModule must use this.
         *
         * Configuration rationale:
         *   IMPORTANCE_HIGH  → heads-up display, interruptive on active screen
         *   setBypassDnd     → request DND bypass (requires ACCESS_NOTIFICATION_POLICY + user grant)
         *   setSound(null)   → MediaPlayer handles audio via USAGE_ALARM (bypasses DND on most devices)
         *   vibration         → triple-buzz pattern for urgency
         *   VISIBILITY_PUBLIC → full detail on lock screen
         *  Package-level accessible so NotificationHelperModule can call it as
         *  OrderAlertService.ensureNotificationChannel(...). */
        @JvmStatic
        fun ensureNotificationChannel(context: Context) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val nm = context.getSystemService(NotificationManager::class.java)
                val channelId = NotificationHelperModule.CHANNEL_ID
                val pattern = NotificationHelperModule.ORDER_ALERT_VIBRATION_PATTERN

                val existing = nm.getNotificationChannel(channelId)
                if (existing == null) {
                    val channel = NotificationChannel(
                        channelId,
                        NotificationHelperModule.CHANNEL_NAME,
                        NotificationManager.IMPORTANCE_HIGH,
                    ).apply {
                        description = "URGENT order alerts — plays loud alarm until accepted or rejected"
                        enableVibration(true)
                        // Shared pattern — the in-app alert vibrates with this same
                        // array, so every new-order alert buzzes identically.
                        vibrationPattern = pattern
                        enableLights(true)
                        lightColor = 0xFF16A34A.toInt()
                        lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                        // MediaPlayer (USAGE_ALARM) handles audio — no channel-level sound
                        setSound(null, null)
                        // Request DND bypass. This only takes effect if the app has been
                        // granted ACCESS_NOTIFICATION_POLICY in system settings.
                        setBypassDnd(true)
                    }
                    nm.createNotificationChannel(channel)
                    Log.d(TAG, "[ORDER-ALERT] Notification channel created: $channelId")
                } else if (channelNeedsVibrationRepair(existing, pattern)) {
                    // A channel installed by an older build keeps its stored config
                    // forever — importance included, which is why the create branch
                    // above only runs once. Vibration is app-writable though, so a
                    // channel that lost the pattern (or had vibration switched off)
                    // is repaired here instead of silently muting every
                    // background/killed order alert.
                    Log.w(
                        TAG,
                        "[ORDER-VIBE] channel ${existing.id} needed repair: " +
                            "vibrates=${existing.shouldVibrate()} " +
                            "pattern=${existing.vibrationPattern?.joinToString()}",
                    )
                    existing.enableVibration(true)
                    existing.vibrationPattern = pattern
                    nm.createNotificationChannel(existing)
                } else {
                    Log.d(
                        TAG,
                        "[ORDER-VIBE] channel ${existing.id} vibrates=${existing.shouldVibrate()} " +
                            "pattern=${existing.vibrationPattern?.joinToString()}",
                    )
                }

                // Log DND bypass status so we know if bypass is actually active.
                // NOTE: getCurrentNotificationPolicy()/Policy.publicModes were removed
                // from newer SDKs, so we log the interruption filter + access grant instead.
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    val dndActive = nm.getCurrentInterruptionFilter() != NotificationManager.INTERRUPTION_FILTER_ALL
                    val dndAccessGranted = nm.isNotificationPolicyAccessGranted()
                    Log.d(TAG, "[ORDER-ALERT] DND active=$dndActive, accessGranted=$dndAccessGranted")
                    Log.d(TAG, "[ORDER-ALERT] Bypass DND requested but depends on user grant in Settings > Notifications > Do Not Disturb")
                }
            }
        }

        /** True when the stored channel would not buzz with the shared pattern. */
        private fun channelNeedsVibrationRepair(
            channel: NotificationChannel,
            pattern: LongArray,
        ): Boolean {
            if (!channel.shouldVibrate()) return true
            return channel.vibrationPattern?.contentEquals(pattern) != true
        }
    }

    // ── State ──

    private val playbackLock = Any()
    private var mediaPlayer: MediaPlayer? = null
    @Volatile
    private var isPlaying = false

    // Audio focus + temporary volume handling for urgent alert playback.
    // We always play through the device's ALARM stream so the OS treats the order siren like an
    // alarm: loud by default, mostly independent of the media volume slider, and eligible for DND
    // bypass when the channel has it. If the device is at low alarm volume when the alert starts,
    // the service temporarily raises the alarm stream to its current maximum for the active alert
    // duration and then restores the previous level. We do NOT persist any change to the user's
    // saved system volume settings and we do NOT disable the physical volume buttons.
    private var audioManager: AudioManager? = null
    private var audioFocusToken: Any? = null
    private var audioFocusRequest: AudioFocusRequest? = null
    private var previousStreamVolume = -1
    private var streamMaxVolume = 0
    private var alertStreamType = AudioManager.STREAM_ALARM

    override fun onBind(intent: Intent?): IBinder? = null

    // ── Lifecycle ──

    override fun onCreate() {
        super.onCreate()
        instance = this
        Log.d(TAG, "Service created")
        ensureNotificationChannel(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            Log.d(TAG, "Stop action received")
            stopPlayback()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }

        val orderId       = intent?.getStringExtra(EXTRA_ORDER_ID)       ?: "unknown"
        val orderNumber   = intent?.getStringExtra(EXTRA_ORDER_NUMBER)   ?: orderId
        val customerName  = intent?.getStringExtra(EXTRA_CUSTOMER_NAME)  ?: ""
        val customerPhone = intent?.getStringExtra(EXTRA_CUSTOMER_PHONE) ?: ""
        val address       = intent?.getStringExtra(EXTRA_ADDRESS)        ?: ""
        val total         = intent?.getStringExtra(EXTRA_TOTAL)          ?: ""
        val paymentMethod = intent?.getStringExtra(EXTRA_PAYMENT_METHOD) ?: ""
        val paymentStatus = intent?.getStringExtra(EXTRA_PAYMENT_STATUS) ?: ""
        val itemsJson     = intent?.getStringExtra(EXTRA_ITEMS_JSON)     ?: "[]"
        val itemCount     = intent?.getStringExtra(EXTRA_ITEM_COUNT)     ?: ""

        Log.d(TAG, "[ORDER-ALERT] starting for order: $orderId")

        try {
            // Same deterministic id the JS layer uses for this order, so both
            // paths post ONE notification per order instead of duplicating it —
            // and dismissing one order's alert can never hit another's.
            val notifId = NotificationHelperModule.notificationIdFor(orderId)
            activeOrderId = orderId

            val notification = buildForegroundNotification(
                orderId, orderNumber, customerName, customerPhone,
                address, total, paymentMethod, paymentStatus, itemsJson, itemCount,
            )
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    notifId,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
                )
            } else {
                startForeground(notifId, notification)
            }
            Log.d(TAG, "[ORDER-ALERT] notification created (id=$notifId)")
            startPlayback()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start foreground service or playback", e)
            activeOrderId = null
            stopSelf()
            return START_NOT_STICKY
        }

        return START_STICKY
    }

    override fun onDestroy() {
        Log.d(TAG, "Service destroyed")
        if (instance == this) {
            instance = null
        }
        stopPlayback()
        // DETACH — keep the notification visible so the user can see what happened
        // even after the service exits. It carries this order's deterministic id,
        // so the app (or a later ORDER_STATUS_UPDATED) can cancel exactly it.
        try { stopForeground(STOP_FOREGROUND_DETACH) } catch (_: Exception) {}
        restoreStreamVolume()
        releaseAudioFocus()
        super.onDestroy()
    }

    // ── Playback ──

    /**
     * Start continuous looping playback of alert.mp3.
     * Thread-safe and protected against concurrent/multiple calls.
     */
    private fun startPlayback() {
        synchronized(playbackLock) {
            if (isPlaying || mediaPlayer != null) {
                Log.d(TAG, "Playback already active or player exists — skipping duplicate start")
                return
            }

            // Centralized sound switch: skip audio only. The service keeps running,
            // so the NEW_ORDER notification, its channel vibration and the
            // ACCEPT / REJECT actions all stay exactly as they are.
            if (!NotificationHelperModule.isNotificationSoundEnabled(applicationContext)) {
                Log.d(TAG, "[ORDER-ALERT] Notification sound muted — playback skipped")
                return
            }

            isPlaying = true

            try {
                val resId = resources.getIdentifier("alert", "raw", packageName)
                if (resId == 0) {
                    Log.e(TAG, "alert.mp3 not found in res/raw — sound will be silent")
                    isPlaying = false
                    releaseAudioFocus()
                    return
                }

                val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
                audioManager = am
                val streamType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    AudioManager.STREAM_ALARM
                } else {
                    AudioManager.STREAM_MUSIC
                }
                alertStreamType = streamType
                previousStreamVolume = am.getStreamVolume(streamType)
                streamMaxVolume = am.getStreamMaxVolume(streamType)

                // Snapshot for the shared-state restore path used by stop(context) when
                // there is no live instance left.
                OrderAlertService.snapshotSharedStreamState(streamType, previousStreamVolume, streamMaxVolume)

                val player = MediaPlayer()
                mediaPlayer = player

                player.apply {
                    setWakeMode(applicationContext, PowerManager.PARTIAL_WAKE_LOCK)
                    setAudioAttributes(
                        AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_ALARM)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .build()
                    )
                    setVolume(1f, 1f)

                    setDataSource(
                        applicationContext,
                        android.net.Uri.parse("android.resource://$packageName/$resId"),
                    )
                    isLooping = true

                    setOnPreparedListener { mp ->
                        synchronized(playbackLock) {
                            if (mediaPlayer == mp && this@OrderAlertService.isPlaying) {
                                mp.start()
                                Log.d(TAG, "[ORDER-ALERT] sound started (continuous loop of alert.mp3)")
                                requestAudioFocus()
                                bumpStreamVolume()
                                // Refresh the per-player gain in case the stream volume was bumped after prepare.
                                if (alertStreamType == AudioManager.STREAM_ALARM && streamMaxVolume > 0) {
                                    mp.setVolume(
                                        streamToGain(audioManager!!.getStreamVolume(alertStreamType), streamMaxVolume),
                                        streamToGain(audioManager!!.getStreamVolume(alertStreamType), streamMaxVolume),
                                    )
                                }
                            } else {
                                Log.d(TAG, "[ORDER-ALERT] player was cancelled before prepare completed")
                                try { mp.release() } catch (_: Exception) {}
                            }
                        }
                    }

                    setOnErrorListener { mp, what, extra ->
                        Log.e(TAG, "Alert playback error: what=$what extra=$extra")
                        synchronized(playbackLock) {
                            if (mediaPlayer == mp) {
                                mediaPlayer = null
                                this@OrderAlertService.isPlaying = false
                            }
                            try { mp.release() } catch (_: Exception) {}
                        }
                        false
                    }

                    prepareAsync()
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to start alert playback", e)
                mediaPlayer = null
                this@OrderAlertService.isPlaying = false
                releaseAudioFocus()
            }
        }
    }

    /**
     * Stop alert playback immediately and correctly release MediaPlayer resources.
     * Thread-safe and safe to call multiple times.
     */
    fun stopPlayback() {
        val token = synchronized(playbackLock) {
            isPlaying = false
            val player = mediaPlayer
            mediaPlayer = null // null FIRST so onPrepared or async listeners recognize cancellation

            if (player != null) {
                try {
                    if (player.isPlaying) {
                        player.stop()
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "Error stopping MediaPlayer", e)
                }
                try {
                    player.reset()
                    player.release()
                } catch (e: Exception) {
                    Log.w(TAG, "Error releasing MediaPlayer", e)
                }
                Log.d(TAG, "[ORDER-ALERT] Alert playback stopped and resources released")
            }

            player
        }

        // Release audio focus and restore the stream to its pre-alert volume.
        // Always run outside the lock so the slow stop/release path does not block the
        // audio-state cleanup.
        if (token != null) {
            restoreStreamVolume()
            releaseAudioFocus()
        }
    }

    private fun createNotificationChannel() {
        ensureNotificationChannel(this)
    }

    // ── Notification Builder ──

    private fun buildForegroundNotification(
        orderId: String,
        orderNumber: String,
        customerName: String,
        customerPhone: String,
        address: String,
        total: String,
        paymentMethod: String,
        paymentStatus: String,
        itemsJson: String,
        itemCountRaw: String,
    ): Notification {

        // ── Parse items ────────────────────────────────────────────────────────
        val parsedItems = parseItemsArray(itemsJson)

        // Prefer the explicit FCM itemCount value; fall back to counting the array.
        val itemCount: Int = itemCountRaw.toIntOrNull()?.takeIf { it >= 0 }
            ?: parsedItems.size

        val itemCountLabel = when (itemCount) {
            0    -> "No items"
            1    -> "1 item"
            else -> "$itemCount items"
        }

        // ── Payment label ──────────────────────────────────────────────────────
        val paymentLabel = friendlyPaymentMethod(paymentMethod)

        // ── PendingIntents ─────────────────────────────────────────────────────
        // Every code is mixed with the order id (multiplication, not `or`) so two
        // orders can never share a target and have FLAG_UPDATE_CURRENT rewrite the
        // other one's button.
        fun requestCode(offset: Int): Int = 0x7FFFFFFF and (31 * orderId.hashCode() + offset)

        val acceptIntent = Intent(this, NotificationActionReceiver::class.java).apply {
            action = NotificationHelperModule.ACTION_ACCEPT
            putExtra(NotificationHelperModule.EXTRA_ORDER_ID, orderId)
            putExtra(NotificationHelperModule.EXTRA_ACTION, NotificationHelperModule.ACTION_ACCEPT)
            putExtra("orderNumber", orderNumber)
        }
        val acceptPending = PendingIntent.getBroadcast(
            this,
            NotificationHelperModule.actionRequestCode(orderId, NotificationHelperModule.ACTION_ACCEPT),
            acceptIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val rejectIntent = Intent(this, NotificationActionReceiver::class.java).apply {
            action = NotificationHelperModule.ACTION_REJECT
            putExtra(NotificationHelperModule.EXTRA_ORDER_ID, orderId)
            putExtra(NotificationHelperModule.EXTRA_ACTION, NotificationHelperModule.ACTION_REJECT)
            putExtra("orderNumber", orderNumber)
        }
        val rejectPending = PendingIntent.getBroadcast(
            this,
            NotificationHelperModule.actionRequestCode(orderId, NotificationHelperModule.ACTION_REJECT),
            rejectIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val tapIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra(EXTRA_ORDER_ID, orderId)
        }
        val tapPending = PendingIntent.getActivity(
            this,
            requestCode(0x30000),
            tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        // Full-screen intent fires when device is locked / screen off.
        val fullScreenPending = PendingIntent.getActivity(
            this,
            requestCode(0x40000),
            tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        // ── Collapsed text (single line shown when notification is not expanded) ─
        val contentText = buildString {
            append("Order #$orderNumber")
            if (customerName.isNotEmpty())  append(" • $customerName")
            if (total.isNotEmpty())         append(" • ₹$total")
            if (paymentMethod.isNotEmpty()) append(" ($paymentLabel)")
            if (itemCount > 0)             append(" • $itemCountLabel")
        }

        // ── Expanded text (BigTextStyle — shown when notification is pulled down) ─
        val bigText = buildString {
            append("Order Number: #$orderNumber\n")
            if (customerName.isNotEmpty()) {
                append("Customer: $customerName\n")
            }
            if (customerPhone.isNotEmpty()) {
                append("Phone: $customerPhone\n")
            }
            if (total.isNotEmpty()) {
                append("Total Amount: ₹$total\n")
            }
            if (paymentMethod.isNotEmpty()) {
                val statusText = if (paymentStatus.isNotEmpty() &&
                        paymentStatus != "pending" &&
                        paymentStatus != "cod") " (${paymentStatus.replaceFirstChar { it.uppercase() }})" else ""
                append("Payment Method: $paymentLabel$statusText\n")
            }
            append("Items: $itemCountLabel\n")

            // Important item/order details
            if (parsedItems.isNotEmpty()) {
                append("\nItems Detail:\n")
                for (row in parsedItems) {
                    append("  • ${row.name} × ${row.qty}")
                    if (row.lineTotal > 0) {
                        append(" (₹${row.lineTotal})")
                    }
                    append("\n")
                }
            }

            // Delivery address
            if (address.isNotEmpty()) {
                append("\nDelivery Address:\n$address")
            }
        }.trimEnd()

        // ── Ticker ─────────────────────────────────────────────────────────────
        val tickerText = buildString {
            append("NEW ORDER #$orderNumber")
            if (customerName.isNotEmpty()) append(" • $customerName")
            if (total.isNotEmpty())        append(" • ₹$total")
        }

        // ── Build ──────────────────────────────────────────────────────────────
        return NotificationCompat.Builder(this, NotificationHelperModule.CHANNEL_ID)
            // Identity
            .setSmallIcon(android.R.drawable.ic_dialog_alert)
            .setColor(0xFF16A34A.toInt())
            .setColorized(true)
            .setContentTitle("NEW ORDER")
            .setSubText("#$orderNumber")           // header area, right of app name
            .setTicker(tickerText)                 // accessibility + lock-screen first glance
            // Content
            .setContentText(contentText)
            .setStyle(
                NotificationCompat.BigTextStyle()
                    .bigText(bigText)
                    .setBigContentTitle("NEW ORDER")
                    .setSummaryText("#$orderNumber"),
            )
            // Urgency
            .setPriority(NotificationCompat.PRIORITY_MAX)        // heads-up on active screen
            .setCategory(NotificationCompat.CATEGORY_ALARM)      // bypass DnD
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC) // full detail on lock screen
            .setFullScreenIntent(fullScreenPending, true)        // popup on sleeping screen
            // Behaviour
            .setOngoing(true)        // swipe-away blocked while service is alive
            .setAutoCancel(false)
            // One buzz per order. The same order id resolves to the same
            // notification id, and both the native receiver and the JS runtime
            // can post it — without this flag each re-post would re-run the
            // channel vibration. The first post still alerts; updates are quiet.
            .setOnlyAlertOnce(true)
            .setLocalOnly(true)      // don't forward to Wear OS
            .setNumber(itemCount)    // badge count
            .setSound(null)          // audio managed by MediaPlayer (USAGE_ALARM)
            .setVibrate(null)        // channel vibration pattern handles it
            // Tap
            .setContentIntent(tapPending)
            // Action buttons — ACCEPT left, REJECT right
            .addAction(
                android.R.drawable.ic_menu_send,
                "ACCEPT",
                acceptPending,
            )
            .addAction(
                android.R.drawable.ic_menu_close_clear_cancel,
                "REJECT",
                rejectPending,
            )
            .build()
    }

    // ── Helpers ──

    /** Temporary volume bump for the active order alert. Uses the current stream's max as
     *  the temporary ceiling, then restores the previous level on stop. */
    private fun bumpStreamVolume() {
        if (alertStreamType == AudioManager.STREAM_ALARM) {
            // On modern Android the alarm stream is already audible at its current level;
            // we still raise it to the stream maximum for the duration of the alert so the
            // siren is genuinely loud, then restore it below.
            try {
                audioManager?.setStreamVolume(
                    alertStreamType,
                    streamMaxVolume,
                    AudioManager.FLAG_SHOW_UI,
                )
                Log.d(TAG, "[ORDER-ALERT] Bumped $alertStreamType volume to $streamMaxVolume")
            } catch (e: SecurityException) {
                Log.w(TAG, "Cannot temporarily raise stream volume: ${e.message}")
            }
        }
        // On older devices we keep using STREAM_MUSIC at its current level; we do not
        // force-boost it there because that stream is shared with media playback expectations
        // and is more likely to be restricted. The USAGE_ALARM + audio focus path is the main
        // loud-path mechanism on those devices.
    }

    private fun restoreStreamVolume() {
        if (alertStreamType != AudioManager.STREAM_ALARM) return
        if (previousStreamVolume < 0) return
        val current = audioManager?.getStreamVolume(alertStreamType) ?: -1
        if (current != previousStreamVolume) {
            try {
                audioManager?.setStreamVolume(
                    alertStreamType,
                    previousStreamVolume,
                    AudioManager.FLAG_SHOW_UI,
                )
                Log.d(TAG, "[ORDER-ALERT] Restored $alertStreamType volume to $previousStreamVolume")
            } catch (e: SecurityException) {
                Log.w(TAG, "Cannot restore stream volume: ${e.message}")
            }
        } else {
            Log.d(TAG, "[ORDER-ALERT] Stream volume already at $previousStreamVolume, skipping restore")
        }
    }

    /** Convert a linear stream volume (0..max) to a MediaPlayer gain in [0.0, 1.0]. */
    private fun streamToGain(current: Int, max: Int): Float {
        if (max <= 0) return 1f
        return (current.toFloat() / max.toFloat()).coerceIn(0f, 1f)
    }

    /** Request audio focus for an urgent, possibly long-running alarm-style playback. The focus
     *  is held until the alert stops (ACCEPT / REJECT / service destroy). On platforms where a
     *  FocusRequest can be registered, we use AudioManager.AUDIOFOCUS_GAIN for maximum loudness. */
    private fun requestAudioFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // Only register once per active alert.
            if (audioFocusRequest != null) return
            try {
                val attrs = AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build()
                audioFocusRequest = AudioFocusRequest.Builder(
                    AudioManager.AUDIOFOCUS_GAIN,
                ).setAudioAttributes(attrs)
                    .setOnAudioFocusChangeListener(
                        object : android.media.AudioManager.OnAudioFocusChangeListener {
                            override fun onAudioFocusChange(focusChange: Int) {
                                when (focusChange) {
                                    AudioManager.AUDIOFOCUS_LOSS,
                                    AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
                                    -> {
                                        // Another app (or system) took focus — pause the siren so we do not fight it.
                                        Log.w(TAG, "[ORDER-ALERT] Lost audio focus: $focusChange")
                                        stopPlayback()
                                    }
                                    else -> {}
                                }
                            }
                        },
                    )
                    .build()
                val am = audioManager ?: return
                val granted = am.requestAudioFocus(audioFocusRequest!!) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
                if (granted) {
                    audioFocusToken = audioFocusRequest
                    Log.d(TAG, "[ORDER-ALERT] Audio focus granted (AUDIOFOCUS_GAIN)")
                } else {
                    Log.w(TAG, "[ORDER-ALERT] Audio focus request not granted")
                    audioFocusRequest = null
                }
            } catch (e: Exception) {
                Log.w(TAG, "[ORDER-ALERT] Audio focus request failed: ${e.message}")
                audioFocusRequest = null
            }
        } else {
            // Legacy path: request focus directly without a FocusRequest.
            val am = audioManager ?: return
            val granted: Boolean = when {
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.M -> {
                    am.requestAudioFocus(
                        object : android.media.AudioManager.OnAudioFocusChangeListener {
                            override fun onAudioFocusChange(focusChange: Int) {
                                when (focusChange) {
                                    AudioManager.AUDIOFOCUS_LOSS,
                                    AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
                                    -> stopPlayback()
                                    else -> {}
                                }
                            }
                        },
                        AudioManager.STREAM_MUSIC,
                        AudioManager.AUDIOFOCUS_GAIN,
                    ) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
                }
                else -> {
                    am.requestAudioFocus(
                        object : android.media.AudioManager.OnAudioFocusChangeListener {
                            override fun onAudioFocusChange(focusChange: Int) {
                                when (focusChange) {
                                    AudioManager.AUDIOFOCUS_LOSS,
                                    AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
                                    -> stopPlayback()
                                    else -> {}
                                }
                            }
                        },
                        AudioManager.STREAM_MUSIC,
                        AudioManager.AUDIOFOCUS_GAIN,
                    ) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
                }
            }
            if (granted) {
                audioFocusToken = am
                Log.d(TAG, "[ORDER-ALERT] Legacy audio focus granted (AUDIOFOCUS_GAIN)")
            } else {
                Log.w(TAG, "[ORDER-ALERT] Legacy audio focus request not granted")
            }
        }
    }

    private fun releaseAudioFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val req = audioFocusRequest
            if (req != null) {
                try {
                    (audioManager ?: return).abandonAudioFocusRequest(req)
                } catch (_: Exception) {}
                audioFocusRequest = null
            }
            audioFocusToken = null
        } else if (audioFocusToken != null) {
            try {
                (audioFocusToken as? AudioManager)?.abandonAudioFocus(
                    object : android.media.AudioManager.OnAudioFocusChangeListener {
                        override fun onAudioFocusChange(focusChange: Int) {}
                    },
                )
            } catch (_: Exception) {}
            audioFocusToken = null
        }
        Log.d(TAG, "[ORDER-ALERT] Audio focus released")
    }

    /** Structured item row parsed from the FCM items JSON array. */
    data class ItemRow(val name: String, val qty: Int, val lineTotal: Int)

    /**
     * Parse the items JSON array from the FCM payload.
     *
     * Expected shape (matches lib/notifications.ts):
     *   [{ name, quantity, price, unitPrice, total }, ...]
     *
     * Line total resolution order: total > price*qty > unitPrice*qty > 0
     */
    private fun parseItemsArray(itemsJson: String): List<ItemRow> {
        return try {
            val array = JSONArray(itemsJson)
            (0 until array.length()).mapNotNull { i ->
                val obj  = array.getJSONObject(i)
                val name = obj.optString("name", "").trim()
                if (name.isEmpty()) return@mapNotNull null

                val qty = obj.optInt("quantity", 1).coerceAtLeast(1)

                val lineTotal: Int = when {
                    obj.has("total") && obj.optDouble("total", 0.0) > 0 ->
                        obj.optDouble("total", 0.0).toInt()
                    obj.has("price") && obj.optDouble("price", 0.0) > 0 ->
                        (obj.optDouble("price", 0.0) * qty).toInt()
                    obj.has("unitPrice") && obj.optDouble("unitPrice", 0.0) > 0 ->
                        (obj.optDouble("unitPrice", 0.0) * qty).toInt()
                    else -> 0
                }

                ItemRow(name, qty, lineTotal)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse items JSON", e)
            emptyList()
        }
    }
}