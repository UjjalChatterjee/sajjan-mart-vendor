package com.sajjanmart

import android.content.Intent
import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  companion object {
    /** order_id from the last NEW_ORDER notification tap, held until JS consumes it. */
    @Volatile
    var pendingTapOrderId: String? = null
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "SajjanMart"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    captureTapOrderId(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    captureTapOrderId(intent)
  }

  /**
   * NEW_ORDER notification tap: stash the order id for JS to pull (cold start,
   * React context not yet ready) and push it to JS when the app is already running.
   */
  private fun captureTapOrderId(intent: Intent?) {
    val orderId = intent?.getStringExtra(NotificationHelperModule.EXTRA_ORDER_ID)
    if (orderId.isNullOrEmpty()) return

    pendingTapOrderId = orderId
    NotificationHelperModule.instance?.emitTapToJS(orderId)
  }
}
