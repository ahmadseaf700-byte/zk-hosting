# DragonHost Agent for Android

This Android app is an early native companion for DragonHost.

## Current stage

- Pair an Android device using the six-digit code from the DragonHost website.
- Store the bearer token using Android EncryptedSharedPreferences.
- Run a foreground service that sends an authenticated heartbeat every 15 seconds.
- Show connection state in an ongoing Android notification.
- Advertise `minecraftRuntime=false` so the backend does not queue Minecraft server tasks for this app yet.

## Important

**This build does not start Minecraft servers.** The Android Java runtime / server process engine has not been integrated. The app intentionally reports that capability as unavailable so it does not claim server creation or start tasks it cannot execute. Termux/Linux Hosting Agent remains the only current server execution path.

## Build APK

GitHub Actions workflow: `.github/workflows/android-apk.yml`

1. Open the repository's Actions tab.
2. Select **Android APK**.
3. Run the workflow manually, or wait for it after an app change is pushed.
4. When the run succeeds, download the `dragonhost-agent-debug` artifact.
5. Extract `app-debug.apk` and install it on an Android device.

The APK is a debug build and is not signed for Play Store release.

## Device setup

1. Sign in to DragonHost in a browser.
2. Choose **ربط جهاز الاستضافة** and copy the six-digit code.
3. Open DragonHost Agent, enter the code and the deployed site URL.
4. Tap **ربط الجهاز**.
5. Allow notifications if Android asks.
6. Keep **تشغيل اتصال الاستضافة** enabled while the device should appear online.

Android may restrict background work. Battery optimization and vendor power-saving settings can still stop a foreground service in some conditions.
