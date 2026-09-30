package com.sajjanmart

import android.app.Application
import android.util.Log
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.common.build.ReactBuildConfig
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost

class MainApplication : Application(), ReactApplication {

  /** Name the JS bundle is embedded under in a standalone APK. */
  private val embeddedBundleName = "index.android.bundle"

  private val hasEmbeddedBundle: Boolean
    get() = applicationContext.assets.list("")?.contains(embeddedBundleName) == true

  /* getDefaultReactHost defaults useDevSupport to ReactBuildConfig.DEBUG, which is
   * true in every debug build — the app would then ask Metro for the script and
   * fail with the bundler stopped. A debug APK that carries its own bundle must
   * load it, so dev support is enabled only when no bundle is embedded. */
  override val reactHost: ReactHost by lazy {
    if (ReactBuildConfig.DEBUG) {
      Log.i(
        "SajjanMart",
        if (hasEmbeddedBundle) "JS source: embedded $embeddedBundleName"
        else "JS source: Metro dev server",
      )
    }
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          add(NotificationHelperPackage())
        },
      useDevSupport = ReactBuildConfig.DEBUG,
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}
