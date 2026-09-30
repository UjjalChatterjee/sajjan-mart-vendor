package com.sajjanmart

import android.content.Context
import android.media.AudioAttributes
import android.os.Build
import android.os.VibrationEffect
import android.os.VibrationAttributes
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log

/**
 * The single new-order haptic owner for this process.
 *
 * Why one owner: Android drives one vibration motor, and every
 * [Vibrator.vibrate] call REPLACES whatever is running. Repeating the alert
 * with JS timers (or with a second native caller on a timer) would make those
 * callers fight over the motor and produce stuttering, overlapping buzzes — and
 * a timer that outlives its screen never stops. So the loop is expressed once,
 * here, as a hardware waveform repeat: [VibrationEffect.createWaveform] with a
 * non-negative repeatIndex loops in the vibrator itself, with no timer re-issuing
 * it, until somebody calls cancel.
 *
 * Refcounted owners (not competing timers): the foreground JS runtime
 * (OWNER_JS, through the in-app alert) and the background/killed
 * [OrderAlertService] (OWNER_SERVICE) may both ask to be alerting. The loop
 * starts with the first owner and stops only when the last one leaves, so a
 * service tearing down can never cut off an alert the app itself is showing.
 *
 * Every request also re-dispatches the loop. Notification posts run the
 * channel-level burst, which replaces whatever the motor was doing, so a
 * re-dispatch is what keeps a pending alert repeating.
 *
 * The alarm usage matters: a bare vibrate(effect) runs with *notification*
 * usage, which the platform and OEM skins (MIUI and friends) drop whenever the
 * ringtone is silent or Do Not Disturb is on. An order alert must not be
 * silenced by that, and vibration is never gated by the sound preference —
 * a muted alert is a silent alert, not an invisible one.
 */
object OrderVibration {

    private const val TAG = "OrderVibration"

    /** The in-app alert, owned by the React Native runtime. */
    const val OWNER_JS = "js"

    /** The background / killed alert, owned by [OrderAlertService]. */
    const val OWNER_SERVICE = "service"

    /**
     * Repeating order-alert waveform: two 400ms buzzes, then a pause.
     *
     * repeatIndex = 1 makes the vibrator loop from the first 400ms entry
     * onwards, so this is continuous vibration for as long as the order stays
     * pending — about 800ms of motor time per 2.5s cycle.
     */
    private val LOOP_PATTERN = longArrayOf(0, 400, 300, 400, 1800)
    private const val LOOP_REPEAT_INDEX = 1

    private val lock = Any()

    /** Who currently wants the alert vibrating. */
    private val owners = mutableSetOf<String>()

    @Volatile
    private var looping = false

    /**
     * Start (or re-assert) the repeating alert for [owner].
     *
     * Calling this again for the same owner does not add a second loop: the
     * vibrator holds one effect at a time, so this is idempotent by design.
     */
    @JvmStatic
    fun start(context: Context, owner: String) {
        val joined = synchronized(lock) { owners.add(owner) }
        Log.i(
            TAG,
            "[ORDER-VIBE] start owner=$owner ${if (joined) "joined" else "already in"} " +
                "owners=${owners.size} looping=$looping",
        )
        dispatch(context, owner)
    }

    /**
     * Leave the alert for [owner]. The motor is cancelled only when the last
     * owner leaves, so the other alert (if any) keeps repeating.
     */
    @JvmStatic
    fun stop(context: Context, owner: String) {
        val empty = synchronized(lock) {
            owners.remove(owner)
            owners.isEmpty()
        }
        if (!empty) {
            Log.i(TAG, "[ORDER-VIBE] owner=$owner left — ${owners.size} owner(s) still alerting")
            return
        }
        cancel(context, owner)
    }

    /** Drop every claim and stop — used when the whole alert bundle is torn down. */
    @JvmStatic
    fun stopAll(context: Context) {
        synchronized(lock) { owners.clear() }
        cancel(context, "all")
    }

    /** True while any owner still wants the repeating alert. */
    @JvmStatic
    fun isVibrating(): Boolean = synchronized(lock) { owners.isNotEmpty() }

    @JvmStatic
    fun ownerCount(): Int = synchronized(lock) { owners.size }

    private fun dispatch(context: Context, owner: String) {
        val sdk = Build.VERSION.SDK_INT
        val motor = vibrator(context)
        if (motor == null) {
            Log.e(TAG, "[ORDER-VIBE] STOPPED HERE — no vibrator handle (sdk=$sdk, owner=$owner)")
            return
        }
        if (!motor.hasVibrator()) {
            Log.e(TAG, "[ORDER-VIBE] STOPPED HERE — device reports no vibration motor (owner=$owner)")
            return
        }

        try {
            if (sdk >= Build.VERSION_CODES.O) {
                val effect = VibrationEffect.createWaveform(LOOP_PATTERN, LOOP_REPEAT_INDEX)
                if (sdk >= Build.VERSION_CODES.S) {
                    motor.vibrate(
                        effect,
                        VibrationAttributes.createForUsage(VibrationAttributes.USAGE_ALARM),
                    )
                    Log.i(TAG, "[ORDER-VIBE] repeating loop dispatched (VibrationAttributes USAGE_ALARM)")
                } else {
                    // API 26–30 (the field device is 29): the bare vibrate(effect)
                    // runs as a *notification*, which MIUI and AOSP both drop when
                    // the ringer is silent. This overload carries the alarm usage.
                    motor.vibrate(
                        effect,
                        AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_ALARM)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .build(),
                    )
                    Log.i(TAG, "[ORDER-VIBE] repeating loop dispatched (AudioAttributes USAGE_ALARM)")
                }
            } else {
                // API 24/25 has no VibrationEffect; the waveform overload there is
                // the only way to express the same repeating pattern.
                @Suppress("DEPRECATION")
                motor.vibrate(LOOP_PATTERN, LOOP_REPEAT_INDEX)
                Log.i(TAG, "[ORDER-VIBE] repeating loop dispatched (legacy waveform)")
            }
            looping = true
        } catch (e: Exception) {
            Log.e(TAG, "[ORDER-VIBE] STOPPED HERE — vibrate() threw: ${e.message}", e)
            looping = false
        }

        Log.i(
            TAG,
            "[ORDER-VIBE] environment owner=$owner sdk=$sdk ringerMode=${ringerMode(context)} " +
                "interruptionFilter=${interruptionFilter(context)} channel=${channelState(context)}",
        )
    }

    private fun cancel(context: Context, lastOwner: String) {
        val wasLooping = looping
        looping = false
        try {
            vibrator(context)?.cancel()
            Log.i(TAG, "[ORDER-VIBE] repeating loop cancelled (last owner=$lastOwner, wasLooping=$wasLooping)")
        } catch (e: Exception) {
            Log.e(TAG, "[ORDER-VIBE] cancel() threw: ${e.message}", e)
        }
    }

    private fun vibrator(context: Context): Vibrator? {
        val manager = context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
        return manager?.defaultVibrator
            ?: context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
    }

    private fun ringerMode(context: Context): String {
        val am = context.getSystemService(Context.AUDIO_SERVICE) as? android.media.AudioManager
            ?: return "unavailable"
        return when (am.ringerMode) {
            android.media.AudioManager.RINGER_MODE_NORMAL -> "normal"
            android.media.AudioManager.RINGER_MODE_VIBRATE -> "vibrate"
            android.media.AudioManager.RINGER_MODE_SILENT -> "silent"
            else -> "unknown(${am.ringerMode})"
        }
    }

    private fun interruptionFilter(context: Context): Int = try {
        context.getSystemService(android.app.NotificationManager::class.java)
            ?.currentInterruptionFilter ?: -1
    } catch (e: Exception) {
        -1
    }

    /** Whether the channel would add its own one-shot burst on a post — a channel
     *  created by an older build keeps its stored config across installs, so this
     *  is logged rather than assumed. */
    private fun channelState(context: Context): String {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return "n/a(pre-O)"
        val channel = try {
            context.getSystemService(android.app.NotificationManager::class.java)
                ?.getNotificationChannel(NotificationHelperModule.CHANNEL_ID)
        } catch (e: Exception) {
            null
        } ?: return "missing"
        return "vibrates=${channel.shouldVibrate()} pattern=${channel.vibrationPattern?.joinToString()}"
    }
}
