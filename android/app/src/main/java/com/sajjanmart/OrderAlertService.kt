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

/**
 * Foreground Service that owns the background / killed order alert.
 *
 * Two continuous things, until the order is decided on ANY device:
 *   - alert.mp3 looped through MediaPlayer, gated by the "Notification Sound"
 *     preference (audio only)
 *   - the repeating haptic, through the single OrderVibration owner — never
 *     gated, because Sound OFF means a silent alert, not an invisible one
 *
 * The notification itself is deliberately generic: "Sajjan Mart" / "1 New
 * Order", no customer, phone, address, amount, items or order id, and NO action
 * buttons. A notification outlives the app on the shade and the lock screen, so
 * it carries nothing a stranger could read. Deciding an order happens in the
 * app: tapping the notification opens the Orders screen.
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
         * The generic order-alert notification id — ONE entry for the service,
         * whatever the number of pending orders behind it.
         *
         * It used to be a legacy fixed id kept only so an older build's
         * notification could still be cleared. Now it is deliberate: the
         * notification no longer describes a specific order, so it has no
         * order-derived id, and `notificationIdFor(orderId)` is still cancelled
         * for a resolved order so an alert posted by an older build cannot
         * linger.
         */
        const val NOTIFICATION_ID = 9999
        private const val ACTION_STOP = "com.sajjanmart.ALERT_STOP"

        /** Exact, order-free notification copy. */
        private const val NOTIFICATION_TITLE = "Sajjan Mart"
        private const val NOTIFICATION_BODY_SINGLE = "1 New Order"

        /** The one tap target of the alert notification. */
        private const val TAP_REQUEST_CODE = 4700

        /** Upper bound on the pending-order count the alert tracks. */
        private const val PENDING_LIMIT = 20

        @JvmStatic
        fun notificationBody(pendingCount: Int): String =
            if (pendingCount <= 1) NOTIFICATION_BODY_SINGLE else "$pendingCount New Orders"

        // Intent extras — only the order id travels. The alert notification is
        // generic by design, so customer / payment / address data is never put
        // into an intent that ends up inside a lock-screen notification.
        private const val EXTRA_ORDER_ID = "order_id"

        /**
         * Orders this device is currently alerting for while the service runs.
         *
         * The generic notification counts them ("1 New Order" / "3 New Orders")
         * and the alert only ends when the last one is decided somewhere, so a
         * second push can neither start a second siren nor make the first one
         * disappear.
         */
        private val pendingOrderIds = LinkedHashSet<String>()

        @Synchronized
        private fun snapshotPending(): List<String> = pendingOrderIds.toList()

        @Synchronized
        private fun addPending(orderId: String): Int {
            pendingOrderIds.add(orderId)
            // Bound it: an unwatched store could otherwise accumulate forever.
            while (pendingOrderIds.size > PENDING_LIMIT) {
                val oldest = pendingOrderIds.iterator().next()
                pendingOrderIds.remove(oldest)
            }
            return pendingOrderIds.size
        }

        @Synchronized
        private fun removePending(orderId: String): Int {
            pendingOrderIds.remove(orderId)
            return pendingOrderIds.size
        }

        @Synchronized
        private fun clearPending() {
            pendingOrderIds.clear()
        }

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

        /**
         * Start (or extend) the native order alert for [orderId].
         *
         * Safe to call multiple times: a repeat start re-posts the same generic
         * notification with its new count, and the running siren / haptic are
         * never duplicated — the MediaPlayer guards on `isPlaying`, and
         * [OrderVibration] holds one hardware loop per owner.
         */
        @JvmStatic
        fun start(context: Context, orderId: String) {
            if (orderId.isBlank() || orderId == "unknown") {
                Log.w(TAG, "[ORDER-ALERT] start called without a usable order id — skipped")
                return
            }

            // An order this device already decided must never ring again — this
            // covers the status push arriving before (or instead of) the NEW_ORDER.
            if (OrderDecisionStore.isResolved(context, orderId)) {
                Log.d(TAG, "[ORDER-ALERT] Order $orderId already resolved — alert skipped")
                return
            }

            // Only the order id goes into the intent. The alert notification is
            // generic, so customer / payment / address data never travels with it.
            val intent = Intent(context, OrderAlertService::class.java).apply {
                putExtra(EXTRA_ORDER_ID, orderId)
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
         * The alert is shared: it ends only when the LAST pending order is gone.
         * While another order is still undecided the siren and the repeating
         * haptic keep running and the generic notification is re-posted with the
         * new count, so one device's decision can never silence another order's
         * alert.
         */
        @JvmStatic
        fun handleOrderResolved(context: Context, orderId: String) {
            if (orderId.isBlank() || orderId == "unknown") return

            val remaining = removePending(orderId)
            val ownsAlert = activeOrderId == orderId

            if (remaining == 0) {
                // Nothing left to alert for — siren, haptic and notification end.
                stop(context)
                cancelAlertNotification(context)
            } else {
                if (ownsAlert) {
                    // The alert bundle belongs to the alert, not to the order that
                    // just settled. Hand it to a still-pending order.
                    activeOrderId = snapshotPending().firstOrNull()
                }
                instance?.repostAlertNotification()
                // A notification posted by an older build carries this order's id.
                cancelNotification(context, NotificationHelperModule.notificationIdFor(orderId))
            }

            Log.d(
                TAG,
                "[ORDER-ALERT] Resolved order $orderId (ownsAlert=$ownsAlert, remaining=$remaining)",
            )
        }

        @JvmStatic
        private fun cancelNotification(context: Context, id: Int) {
            try {
                val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                nm.cancel(id)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to cancel notification id $id", e)
            }
        }

        @JvmStatic
        private fun cancelAlertNotification(context: Context) {
            // Ours only: never cancels another app's or another alert's entry.
            cancelNotification(context, NOTIFICATION_ID)
        }

        /**
         * Silence the alert (siren + haptic) for an order WITHOUT cancelling its
         * notification.
         *
         * Used the instant a notification action button is tapped: the loop must
         * stop on the fingertip, but the order has not been decided yet. If the
         * backend call then fails, the notification is still in the tray, so the
         * alert stays recoverable instead of vanishing on an unconfirmed decision.
         * (The current alert notification carries no buttons — this stays for any
         * actionable notification the app posts again.)
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
            OrderVibration.stop(context, OrderVibration.OWNER_SERVICE)
            activeOrderId = null
            // stopService → onDestroy → stopForeground(DETACH): the looping audio
            // and the foreground-service state end, the notification survives.
            try {
                context.stopService(Intent(context, OrderAlertService::class.java))
            } catch (e: Exception) {
                Log.w(TAG, "[ORDER-ALERT] Could not stop the service cleanly: ${e.message}")
            }
            restoreSharedStreamState(context)
            Log.d(TAG, "[ORDER-ALERT] Alert silenced for $orderId, notification kept")
        }

        /** Stop the order alert service: release audio, stop the repeating haptic
         *  and forget the pending set.
         *  Safe to call multiple times from any thread or receiver. */
        @JvmStatic
        fun stop(context: Context) {
            // Immediate in-memory stop for 0ms latency on ACCEPT/REJECT
            instance?.stopPlayback()
            OrderVibration.stop(context, OrderVibration.OWNER_SERVICE)
            clearPending()
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

        /**
         * Single source of truth for the order alert notification channel.
         * Both OrderAlertService and NotificationHelperModule must use this.
         *
         * Configuration rationale:
         *   IMPORTANCE_HIGH  → heads-up display, interruptive on active screen
         *   setBypassDnd     → request DND bypass (requires ACCESS_NOTIFICATION_POLICY + user grant)
         *   setSound(null)   → MediaPlayer handles audio via USAGE_ALARM (bypasses DND on most devices)
         *   vibration         → one-shot triple buzz PER POST. A channel cannot loop,
         *                       and posting replaces whatever the motor is doing, so
         *                       this is only the first touch of an alert — the
         *                       repeating haptic is owned by OrderVibration, which
         *                       re-dispatches the loop right after every post.
         *   lockscreenVisibility → app-writable settings only. Importance and
         *                       lock-screen visibility are frozen at channel creation
         *                       (an installed device keeps PUBLIC), which is safe now
         *                       because the notification text is generic.
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
            OrderVibration.stop(applicationContext, OrderVibration.OWNER_SERVICE)
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }

        val orderId = intent?.getStringExtra(EXTRA_ORDER_ID)
        if (orderId.isNullOrBlank() || orderId == "unknown") {
            Log.w(TAG, "[ORDER-ALERT] start without a usable order id — stopping")
            stopSelf()
            return START_NOT_STICKY
        }

        // A START_STICKY redelivery can land after the order was decided, so the
        // decided set is checked here too, not only at start().
        if (OrderDecisionStore.isResolved(this, orderId)) {
            Log.d(TAG, "[ORDER-ALERT] Order $orderId is already decided — not re-alerting")
            if (snapshotPending().isEmpty()) stopSelf()
            return START_NOT_STICKY
        }

        val pendingCount = addPending(orderId)
        // One siren owner: a second pending order must not steal the alert from
        // the order that is already ringing.
        if (activeOrderId == null) activeOrderId = orderId

        Log.d(TAG, "[ORDER-ALERT] starting for order: $orderId (pending=$pendingCount)")

        try {
            // ONE generic notification for the service. It names no order, so a
            // repeat push just re-posts it with a new count instead of stacking a
            // second entry, and cancelling it can never hit another app.
            val notification = buildAlertNotification(pendingCount)
            startAlertForeground(notification)
            startPlayback()
            /*
             * The repeating haptic is started OUTSIDE the sound switch that gates
             * startPlayback(): Sound OFF mutes the siren, it never mutes the
             * vibration. It is dispatched after the post because a notification
             * runs the channel's one-shot burst, which replaces whatever the
             * motor was doing — re-asserting here is what keeps the loop alive.
             */
            OrderVibration.start(applicationContext, OrderVibration.OWNER_SERVICE)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start foreground service or playback", e)
            removePending(orderId)
            if (activeOrderId == orderId) activeOrderId = snapshotPending().firstOrNull()
            OrderVibration.stop(applicationContext, OrderVibration.OWNER_SERVICE)
            stopSelf()
            return START_NOT_STICKY
        }

        return START_STICKY
    }

    /**
     * Promote this service to the foreground with the generic alert
     * notification. mediaPlayback is the declared type because the service's
     * foreground work is the looping alert sound.
     */
    private fun startAlertForeground(notification: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        Log.d(TAG, "[ORDER-ALERT] alert notification posted (id=$NOTIFICATION_ID)")
    }

    /**
     * Re-post the generic notification when the pending count changed — an order
     * was decided somewhere else while another one is still awaiting a decision.
     */
    fun repostAlertNotification() {
        try {
            startAlertForeground(buildAlertNotification(snapshotPending().size))
        } catch (e: Exception) {
            Log.w(TAG, "[ORDER-ALERT] Could not re-post the alert notification: ${e.message}")
        }
    }

    override fun onDestroy() {
        Log.d(TAG, "Service destroyed")
        if (instance == this) {
            instance = null
        }
        stopPlayback()
        // The service's own claim on the haptic ends here. OrderVibration keeps
        // vibrating if the app itself is still alerting (OWNER_JS).
        OrderVibration.stop(applicationContext, OrderVibration.OWNER_SERVICE)
        // DETACH — keep the notification visible so the user can see what happened
        // even after the service exits. It is the generic alert entry, so the app
        // (or a later ORDER_STATUS_UPDATED) cancels it by NOTIFICATION_ID.
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

    /**
     * The generic order-alert notification.
     *
     * Exactly two strings, no order data:
     *   title  "Sajjan Mart"
     *   body   "1 New Order" — or "3 New Orders" when more are pending
     *
     * Deliberately absent: customer name, phone, products, amount, address and
     * order id, plus the ACCEPT / REJECT action buttons. This entry outlives the
     * app in the shade and on the lock screen, and a store device is not a
     * private place. Deciding an order happens in the app: tapping the
     * notification opens it on the Orders screen.
     *
     * No full-screen intent either — that would auto-launch order UI over a
     * locked screen.
     */
    private fun buildAlertNotification(pendingCount: Int): Notification {
        val body = notificationBody(pendingCount)

        val tapIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra(NotificationHelperModule.EXTRA_OPEN_ORDERS, true)
        }
        // One stable request code: the tap target never varies, so a re-post can
        // never leave an old PendingIntent pointing somewhere else.
        val tapPending = PendingIntent.getActivity(
            this,
            TAP_REQUEST_CODE,
            tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        return NotificationCompat.Builder(this, NotificationHelperModule.CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_alert)
            .setColor(0xFF16A34A.toInt())
            .setColorized(true)
            .setContentTitle(NOTIFICATION_TITLE)
            .setContentText(body)
            .setTicker(body)
            // The entry still has to interrupt — that part is not sensitive.
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setOngoing(true)
            .setAutoCancel(false)
            // One buzz per order count change, not one per re-post.
            .setOnlyAlertOnce(true)
            .setLocalOnly(true)
            .setNumber(pendingCount)
            .setSound(null)          // audio is MediaPlayer (USAGE_ALARM)
            .setVibrate(null)        // channel burst + OrderVibration own the haptic
            .setContentIntent(tapPending)
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

}
