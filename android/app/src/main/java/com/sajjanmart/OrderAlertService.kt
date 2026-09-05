package com.sajjanmart

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import org.json.JSONArray

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

        /**
         * Start the order alert service with full order details.
         * Safe to call multiple times — duplicate starts are ignored by the
         * isPlaying guard in startPlayback().
         */
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

        /**
         * Stop the order alert service and release audio immediately.
         * Safe to call multiple times from any thread or receiver.
         */
        fun stop(context: Context) {
            // Immediate in-memory stop for 0ms latency on ACCEPT/REJECT
            instance?.stopPlayback()

            try {
                val stopIntent = Intent(context, OrderAlertService::class.java).apply {
                    action = ACTION_STOP
                }
                context.startService(stopIntent)
            } catch (_: Exception) {}

            try {
                context.stopService(Intent(context, OrderAlertService::class.java))
            } catch (_: Exception) {}
        }

        /**
         * Map raw FCM paymentMethod values to human-readable labels.
         *   "cod"       -> "Cash on Delivery"
         *   "online"    -> "Online Payment"
         *   "upi"       -> "UPI"
         */
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
         */
        /** Ensure the notification channel exists with the correct urgent configuration.
         *  Safe to call multiple times — Android ignores duplicate channel creation. */
        fun ensureNotificationChannel(context: Context) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val nm = context.getSystemService(NotificationManager::class.java)
                val channelId = NotificationHelperModule.CHANNEL_ID

                if (nm.getNotificationChannel(channelId) == null) {
                    val channel = NotificationChannel(
                        channelId,
                        NotificationHelperModule.CHANNEL_NAME,
                        NotificationManager.IMPORTANCE_HIGH,
                    ).apply {
                        description = "URGENT order alerts — plays loud alarm until accepted or rejected"
                        enableVibration(true)
                        vibrationPattern = longArrayOf(0, 300, 200, 300, 200, 300)
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
    }

    // ── State ──

    private val playbackLock = Any()
    private var mediaPlayer: MediaPlayer? = null
    @Volatile
    private var isPlaying = false

    override fun onBind(intent: Intent?): IBinder? = null

    // ── Lifecycle ──

    override fun onCreate() {
        super.onCreate()
        instance = this
        Log.d(TAG, "Service created")
        createNotificationChannel()
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
            val notification = buildForegroundNotification(
                orderId, orderNumber, customerName, customerPhone,
                address, total, paymentMethod, paymentStatus, itemsJson, itemCount,
            )
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
                )
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
            Log.d(TAG, "[ORDER-ALERT] notification created")
            startPlayback()

            // Ensure any duplicate default Firebase notification is cancelled immediately and after slight delays
            CustomMessagingReceiver.suppressDuplicateNotifications(this)
            android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                CustomMessagingReceiver.suppressDuplicateNotifications(this@OrderAlertService)
            }, 500)
            android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                CustomMessagingReceiver.suppressDuplicateNotifications(this@OrderAlertService)
            }, 1500)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start foreground service or playback", e)
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
        // DETACH — keep notification visible so the user can see what happened
        // even after the service exits. JS task or NativeOrderApiService will
        // call cancelAll() on success.
        try { stopForeground(STOP_FOREGROUND_DETACH) } catch (_: Exception) {}
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
            isPlaying = true

            try {
                val resId = resources.getIdentifier("alert", "raw", packageName)
                if (resId == 0) {
                    Log.e(TAG, "alert.mp3 not found in res/raw — sound will be silent")
                    isPlaying = false
                    return
                }

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
            }
        }
    }

    /**
     * Stop alert playback immediately and correctly release MediaPlayer resources.
     * Thread-safe and safe to call multiple times.
     */
    fun stopPlayback() {
        synchronized(playbackLock) {
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

        val acceptIntent = Intent(this, NotificationActionReceiver::class.java).apply {
            action = NotificationHelperModule.ACTION_ACCEPT
            putExtra(NotificationHelperModule.EXTRA_ORDER_ID, orderId)
            putExtra(NotificationHelperModule.EXTRA_ACTION, NotificationHelperModule.ACTION_ACCEPT)
        }
        val acceptPending = PendingIntent.getBroadcast(
            this,
            orderId.hashCode() or 0x10000,
            acceptIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val rejectIntent = Intent(this, NotificationActionReceiver::class.java).apply {
            action = NotificationHelperModule.ACTION_REJECT
            putExtra(NotificationHelperModule.EXTRA_ORDER_ID, orderId)
            putExtra(NotificationHelperModule.EXTRA_ACTION, NotificationHelperModule.ACTION_REJECT)
        }
        val rejectPending = PendingIntent.getBroadcast(
            this,
            orderId.hashCode() or 0x20000,
            rejectIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val tapIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra(EXTRA_ORDER_ID, orderId)
        }
        val tapPending = PendingIntent.getActivity(
            this,
            orderId.hashCode() or 0x30000,
            tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        // Full-screen intent fires when device is locked / screen off.
        val fullScreenPending = PendingIntent.getActivity(
            this,
            orderId.hashCode() or 0x40000,
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
