package com.sajjanmart

import android.app.Notification
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.ConnectException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.net.URLEncoder

/**
 * Native service that calls the Accept/Reject order API directly —
 * no React Native JS runtime dependency.
 *
 * Used when the app is backgrounded or killed: the JS runtime is not
 * running and we cannot rely on HeadlessJsTask cold boot being fast
 * or reliable enough for a time-sensitive order action.
 *
 * Runs as a foreground service: the receiver that starts it may be the only
 * thing keeping this process alive, and a plain background service start is
 * restricted (and on Android 12+ throws) for a process revived by a tap.
 *
 * Flow:
 *   NotificationActionReceiver
 *     → silence OrderAlertService (sound only; its notification STAYS)
 *     → start NativeOrderApiService (foreground, "Sending…" entry)
 *         → read access token from AsyncStorage SQLite DB
 *         → PUT {base}/api/orders/{orderId}  { "status": "confirmed" | "cancelled" }
 *         → success / 409 : record the decision, cancel this order's notification,
 *                           post a quiet outcome line
 *         → any failure   : leave the order alert in place as the retry point,
 *                           post the actual error, never mark the order resolved
 *
 * Base URL:
 *   ApiBaseUrlStore — written by JS from Env.API_BASE_URL, the same address the
 *   app itself uses. There are no loopback fallbacks any more: the previous
 *   127.0.0.1 / 10.0.2.2 candidates could never reach the deployed backend, so
 *   every killed-app tap failed with "No connection" and no order was decided.
 *
 * Token storage:
 *   @react-native-async-storage uses a Room-backed SQLite DB:
 *     Database : "AsyncStorage"
 *     Table    : "Storage"
 *     Key col  : "key"      Value col : "value"
 *     Access token key : "@sajjanmart:accessToken"
 *
 * Auth contract (identical to src/services/api.client.ts):
 *   Bearer header for the order call; refresh is POST /api/auth/refresh with
 *   { "refreshToken": … } in the JSON body — the backend reads that body, or a
 *   `refresh_token` cookie, and returns a new pair. Both tokens are stored,
 *   because the backend rotates the refresh token too.
 */
class NativeOrderApiService : Service() {

    companion object {
        private const val TAG = "NativeOrderApiService"
        private const val ACTION_ACCEPT = "com.sajjanmart.ORDER_ACCEPT"
        private const val ACTION_REJECT = "com.sajjanmart.ORDER_REJECT"

        // AsyncStorage Room DB constants (from @react-native-async-storage source)
        private const val DB_NAME           = "AsyncStorage"
        private const val TABLE_NAME        = "Storage"
        private const val COLUMN_KEY        = "key"
        private const val COLUMN_VALUE      = "value"
        private const val ACCESS_TOKEN_KEY  = "@sajjanmart:accessToken"
        private const val REFRESH_TOKEN_KEY = "@sajjanmart:refreshToken"

        private const val CONNECT_TIMEOUT_MS  = 12_000
        private const val READ_TIMEOUT_MS     = 12_000

        /**
         * Taps of the same (action, order) that are already in flight. A double
         * tap must produce one request, not two; the backend's atomic
         * pending-exit claim answers 409 to the second one anyway, so this is
         * about noise, not correctness. Cleared when the call settles, so a
         * genuine retry after a failure is never blocked.
         */
        private val inFlight = mutableSetOf<String>()
        private val inFlightLock = Any()

        private fun tryClaim(key: String): Boolean = synchronized(inFlightLock) {
            if (inFlight.contains(key)) false else { inFlight.add(key); true }
        }

        private fun release(key: String) {
            synchronized(inFlightLock) { inFlight.remove(key) }
        }
    }

    private enum class ApiResult { SUCCESS, AUTH_ERROR, SERVER_ERROR, NETWORK_ERROR, CONFLICT }

    /** Set for the life of the running call so cleanup knows what it owns. */
    private var claimedKey: String? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val orderId     = intent?.getStringExtra(NotificationHelperModule.EXTRA_ORDER_ID)
        val action      = intent?.getStringExtra(NotificationHelperModule.EXTRA_ACTION)
        val orderNumber = intent?.getStringExtra("orderNumber") ?: orderId

        if (orderId == null || action == null) {
            Log.e(TAG, "[ORDER-ACTION] Missing orderId or action — stopping")
            stopSelf()
            return START_NOT_STICKY
        }

        val actionName = when (action) {
            ACTION_ACCEPT -> "ACCEPT"
            ACTION_REJECT -> "REJECT"
            else          -> action
        }

        val newStatus = when (action) {
            ACTION_ACCEPT -> "confirmed"
            ACTION_REJECT -> "cancelled"
            else -> {
                Log.e(TAG, "[ORDER-ACTION] Unknown action: $action")
                stopSelf()
                return START_NOT_STICKY
            }
        }

        val key = "$action:$orderId"
        if (!tryClaim(key)) {
            Log.d(TAG, "[ORDER-ACTION] $actionName for order $orderId already in flight — ignoring duplicate tap")
            stopSelf()
            return START_NOT_STICKY
        }
        claimedKey = key

        Log.d(TAG, "[ORDER-ACTION] $actionName for order $orderId (status → $newStatus)")

        // An FGS must be foreground within seconds of the start, or the system
        // kills the process — do it first, before any I/O.
        if (!enterForeground(orderName(actionName), orderNumber ?: orderId)) {
            release(key)
            claimedKey = null
            stopSelf()
            return START_NOT_STICKY
        }

        // All network work on a background thread — never block the main thread
        Thread {
            try {
                runDecision(orderId, orderNumber ?: orderId, newStatus, actionName)
            } catch (e: Exception) {
                Log.e(TAG, "[ORDER-ACTION] Unexpected error: ${e.message}", e)
                keepAlertForRetry(orderId, orderNumber ?: orderId, actionName, e.message ?: "unknown error")
            } finally {
                release(key)
                claimedKey = null
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }.start()

        return START_NOT_STICKY
    }

    private fun orderName(actionName: String): String =
        if (actionName == "ACCEPT") "Accepting" else "Rejecting"

    /** Promote this service to foreground with a quiet "submitting" entry. */
    private fun enterForeground(label: String, orderNumber: String): Boolean {
        NativeOrderFeedback.ensureChannel(this)
        val notification: Notification = NotificationCompat.Builder(this, NativeOrderFeedback.CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("$label order #$orderNumber")
            .setContentText("Sending the decision to the server…")
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .setSilent(true)
            .build()
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(
                    NativeOrderFeedback.ID_PROGRESS,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
                )
            } else {
                startForeground(NativeOrderFeedback.ID_PROGRESS, notification)
            }
            true
        } catch (e: Exception) {
            Log.e(TAG, "[ORDER-ACTION] Could not enter foreground: ${e.message}", e)
            NativeOrderFeedback.show(
                this,
                NativeOrderFeedback.ID_RESULT,
                "Order Action Not Sent",
                "The app could not submit order #$orderNumber in the background. " +
                    "Open the app to $label it.",
                orderId = null,
            )
            false
        }
    }

    // ── Decision ──────────────────────────────────────────────────────────────

    private fun runDecision(orderId: String, orderNumber: String, newStatus: String, actionName: String) {
        val baseUrl = ApiBaseUrlStore.read(this)
        if (baseUrl == null) {
            Log.e(TAG, "[ORDER-ACTION] No API base URL stored — open the app once so JS can publish Env.API_BASE_URL")
            keepAlertForRetry(orderId, orderNumber, actionName, "no server address stored (open the app once)")
            return
        }
        Log.d(TAG, "[ORDER-ACTION] Using API base URL $baseUrl")

        val token = readTokenFromDb(ACCESS_TOKEN_KEY) ?: tryRefreshToken(baseUrl)
        if (token == null) {
            Log.e(TAG, "[ORDER-ACTION] No usable access token — refresh failed")
            keepAlertForRetry(orderId, orderNumber, actionName, "session expired and the token refresh failed")
            return
        }

        val encodedId = URLEncoder.encode(orderId, "UTF-8")
        val bodyBytes = JSONObject().apply { put("status", newStatus) }.toString().toByteArray()

        when (callOrderApi(baseUrl, encodedId, bodyBytes, token)) {
            ApiResult.SUCCESS -> confirmDecision(orderId, orderNumber, actionName)
            ApiResult.CONFLICT -> staleDecision(orderId, orderNumber)
            ApiResult.AUTH_ERROR -> {
                // The stored token was rejected outright: renew once and retry.
                Log.w(TAG, "[ORDER-ACTION] Auth error (401/403) — refreshing token and retrying")
                val fresh = tryRefreshToken(baseUrl)
                if (fresh == null) {
                    keepAlertForRetry(orderId, orderNumber, actionName, "session expired and the token refresh failed")
                    return
                }
                when (callOrderApi(baseUrl, encodedId, bodyBytes, fresh)) {
                    ApiResult.SUCCESS  -> confirmDecision(orderId, orderNumber, actionName)
                    ApiResult.CONFLICT -> staleDecision(orderId, orderNumber)
                    ApiResult.AUTH_ERROR -> keepAlertForRetry(
                        orderId, orderNumber, actionName, "the server kept rejecting the session (401/403)",
                    )
                    ApiResult.NETWORK_ERROR -> keepAlertForRetry(
                        orderId, orderNumber, actionName, "could not reach $baseUrl",
                    )
                    else -> keepAlertForRetry(
                        orderId, orderNumber, actionName, "server error after a token refresh",
                    )
                }
            }
            ApiResult.NETWORK_ERROR ->
                keepAlertForRetry(orderId, orderNumber, actionName, "could not reach $baseUrl")
            ApiResult.SERVER_ERROR ->
                keepAlertForRetry(orderId, orderNumber, actionName, "the server rejected the change (see logcat)")
        }
    }

    /** The backend took the decision: this device's alert is finished. */
    private fun confirmDecision(orderId: String, orderNumber: String, actionName: String) {
        Log.d(TAG, "[ORDER-ACTION] ✓ $actionName order $orderId confirmed by server")
        OrderDecisionStore.markResolved(applicationContext, orderId)
        // The only place the order notification is cancelled — after success.
        // The other admin devices get the same cleanup from the backend's
        // ORDER_STATUS_UPDATED push (CustomMessagingReceiver handles it natively).
        OrderAlertService.handleOrderResolved(applicationContext, orderId)
        NativeOrderFeedback.show(
            applicationContext,
            NativeOrderFeedback.ID_RESULT,
            if (actionName == "ACCEPT") "Order Accepted" else "Order Rejected",
            "Order #$orderNumber ${if (actionName == "ACCEPT") "accepted" else "rejected"} — confirmed by the server.",
            orderId = orderId,
        )
    }

    /** 409 — another device settled it first, so this alert is stale, not retryable. */
    private fun staleDecision(orderId: String, orderNumber: String) {
        Log.w(TAG, "[ORDER-ACTION] 409 — order $orderId already decided on another device")
        OrderDecisionStore.markResolved(applicationContext, orderId)
        OrderAlertService.handleOrderResolved(applicationContext, orderId)
        NativeOrderFeedback.show(
            applicationContext,
            NativeOrderFeedback.ID_RESULT,
            "Order Already Handled",
            "Order #$orderNumber was already accepted or rejected on another device.",
            orderId = orderId,
        )
    }

    /**
     * The decision did not reach the backend.
     *
     * The order alert notification is deliberately NOT cancelled: it still
     * carries working ACCEPT / REJECT buttons and the tap-to-open intent, so the
     * alert is recoverable rather than silently dismissed. The order is NOT
     * recorded as resolved either, so its NEW_ORDER alert can never be muted on
     * the strength of a call that failed.
     */
    private fun keepAlertForRetry(orderId: String, orderNumber: String, actionName: String, reason: String) {
        Log.e(TAG, "[ORDER-ACTION] ✗ $actionName order $orderId NOT sent — $reason")
        NativeOrderFeedback.show(
            applicationContext,
            NativeOrderFeedback.ID_RESULT,
            "Order Action Failed — Tap to Retry",
            "$actionName for order #$orderNumber was NOT sent ($reason). " +
                "The order alert is still in the shade — tap it to open the app and decide again.",
            orderId = orderId,
        )
    }

    // ── SQLite token helpers ──────────────────────────────────────────────────

    // ── Token storage ─────────────────────────────────────────────────────────

    /**
     * Read any value from the AsyncStorage SQLite database.
     * Tries two path conventions in order:
     *   1. context.getDatabasePath("AsyncStorage")  — standard Room location
     *   2. <dataDir>/databases/AsyncStorage           — explicit fallback
     */
    private fun readTokenFromDb(key: String): String? {
        val candidates = listOf(
            getDatabasePath(DB_NAME),
            java.io.File(filesDir.parentFile, "databases/$DB_NAME"),
        )
        for (dbFile in candidates) {
            if (!dbFile.exists()) continue
            try {
                val db = android.database.sqlite.SQLiteDatabase.openDatabase(
                    dbFile.absolutePath, null,
                    android.database.sqlite.SQLiteDatabase.OPEN_READONLY,
                )
                var value: String? = null
                val cursor = db.rawQuery(
                    "SELECT `$COLUMN_VALUE` FROM `$TABLE_NAME` WHERE `$COLUMN_KEY` = ?",
                    arrayOf(key),
                )
                if (cursor.moveToFirst()) value = cursor.getString(0)
                cursor.close()
                db.close()
                if (!value.isNullOrEmpty()) {
                    Log.d(TAG, "[ORDER-ACTION] Read '$key' from ${dbFile.name}")
                    return value
                }
            } catch (e: Exception) {
                Log.w(TAG, "[ORDER-ACTION] DB read error at ${dbFile.name}: ${e.message}")
            }
        }
        Log.e(TAG, "[ORDER-ACTION] Key '$key' not found in AsyncStorage DB")
        return null
    }

    private fun persistTokenToDb(key: String, value: String) {
        val candidates = listOf(
            getDatabasePath(DB_NAME),
            java.io.File(filesDir.parentFile, "databases/$DB_NAME"),
        )
        for (dbFile in candidates) {
            if (!dbFile.exists()) continue
            try {
                val db = android.database.sqlite.SQLiteDatabase.openDatabase(
                    dbFile.absolutePath, null,
                    android.database.sqlite.SQLiteDatabase.OPEN_READWRITE,
                )
                val cv = android.content.ContentValues().apply {
                    put(COLUMN_KEY, key)
                    put(COLUMN_VALUE, value)
                }
                db.insertWithOnConflict(
                    TABLE_NAME, null, cv,
                    android.database.sqlite.SQLiteDatabase.CONFLICT_REPLACE,
                )
                db.close()
                return
            } catch (e: Exception) {
                Log.w(TAG, "[ORDER-ACTION] DB write error at ${dbFile.name}: ${e.message}")
            }
        }
    }

    // ── Token refresh ─────────────────────────────────────────────────────────

    /**
     * POST {base}/api/auth/refresh with { "refreshToken": … } in the JSON body —
     * the exact contract src/services/api.client.ts uses.
     *
     * This used to send `Cookie: refreshToken=…` with an empty body. The backend
     * reads the body or a `refresh_token` cookie (never `refreshToken`), so every
     * native refresh answered 401 "Refresh token missing" and a killed app with an
     * expired 15-minute access token could never decide an order.
     *
     * Persists BOTH tokens: the backend rotates the refresh token as well, and
     * keeping only the access token would strand the next refresh on a stale one.
     * Never logs a token value.
     */
    private fun tryRefreshToken(baseUrl: String): String? {
        val refreshToken = readTokenFromDb(REFRESH_TOKEN_KEY) ?: return null
        return try {
            val conn = URL("$baseUrl/api/auth/refresh").openConnection() as HttpURLConnection
            try {
                conn.requestMethod = "POST"
                conn.setRequestProperty("Content-Type", "application/json")
                conn.setRequestProperty("Accept", "application/json")
                conn.connectTimeout = CONNECT_TIMEOUT_MS
                conn.readTimeout    = READ_TIMEOUT_MS
                conn.doOutput = true
                conn.outputStream.use {
                    it.write(JSONObject().apply { put("refreshToken", refreshToken) }.toString().toByteArray())
                }

                val code = conn.responseCode
                if (code !in 200..299) {
                    Log.e(TAG, "[ORDER-ACTION] Refresh HTTP $code from $baseUrl")
                    return null
                }
                val json = JSONObject(conn.inputStream.bufferedReader().readText())
                val newAccessToken = json.optString("accessToken")
                    .takeIf { it.isNotEmpty() }
                    ?: json.optString("token").takeIf { it.isNotEmpty() }
                if (newAccessToken == null) {
                    Log.e(TAG, "[ORDER-ACTION] Refresh response carried no access token")
                    return null
                }
                Log.d(TAG, "[ORDER-ACTION] Token refresh succeeded via $baseUrl")
                persistTokenToDb(ACCESS_TOKEN_KEY, newAccessToken)
                json.optString("refreshToken").takeIf { it.isNotEmpty() }?.let {
                    persistTokenToDb(REFRESH_TOKEN_KEY, it)
                }
                newAccessToken
            } finally {
                conn.disconnect()
            }
        } catch (e: ConnectException) {
            Log.e(TAG, "[ORDER-ACTION] Refresh: connect failed to $baseUrl")
            null
        } catch (e: Exception) {
            Log.e(TAG, "[ORDER-ACTION] Refresh error ($baseUrl): ${e.message}")
            null
        }
    }

    // ── HTTP helpers ──────────────────────────────────────────────────────────

    /**
     * Call PUT {base}/api/orders/{encodedId}.
     * SUCCESS on 2xx, AUTH_ERROR on 401/403, CONFLICT on 409 (another device
     * decided first), SERVER_ERROR on any other answer, NETWORK_ERROR when the
     * server could not be reached at all.
     */
    private fun callOrderApi(
        baseUrl: String,
        encodedId: String,
        bodyBytes: ByteArray,
        token: String,
    ): ApiResult {
        return try {
            val url  = URL("$baseUrl/api/orders/$encodedId")
            val conn = url.openConnection() as HttpURLConnection
            try {
                conn.requestMethod = "PUT"
                conn.setRequestProperty("Content-Type", "application/json")
                conn.setRequestProperty("Accept",       "application/json")
                conn.setRequestProperty("Authorization", "Bearer $token")
                conn.connectTimeout = CONNECT_TIMEOUT_MS
                conn.readTimeout    = READ_TIMEOUT_MS
                conn.doOutput       = true
                conn.outputStream.use { os: OutputStream -> os.write(bodyBytes) }

                val code = conn.responseCode
                Log.d(TAG, "[ORDER-ACTION] PUT $baseUrl/api/orders/$encodedId → HTTP $code")

                // Log body for debugging (truncated, no tokens)
                val stream = if (code in 200..299) conn.inputStream else conn.errorStream
                if (stream != null) {
                    val resp = BufferedReader(InputStreamReader(stream)).readText()
                    Log.d(TAG, "[ORDER-ACTION] Response: ${resp.take(300)}")
                }

                when (code) {
                    in 200..299 -> ApiResult.SUCCESS
                    401, 403    -> ApiResult.AUTH_ERROR
                    // The atomic pending-exit transition answered: another device
                    // already decided this order.
                    409         -> ApiResult.CONFLICT
                    else        -> ApiResult.SERVER_ERROR
                }
            } finally {
                conn.disconnect()
            }
        } catch (e: ConnectException) {
            Log.w(TAG, "[ORDER-ACTION] ConnectException ($baseUrl): ${e.message}")
            ApiResult.NETWORK_ERROR
        } catch (e: SocketTimeoutException) {
            Log.w(TAG, "[ORDER-ACTION] Timeout ($baseUrl): ${e.message}")
            ApiResult.NETWORK_ERROR
        } catch (e: Exception) {
            Log.e(TAG, "[ORDER-ACTION] HTTP error ($baseUrl): ${e.message}")
            ApiResult.NETWORK_ERROR
        }
    }
}
