# Android Embedded JVM — Technical Design

Status: design decision only. This document does not claim that Minecraft can run in the Android APK yet.

## Current state

The Android app currently pairs with DragonHost and sends authenticated heartbeats. It advertises `minecraftRuntime=false`, which is intentional. The backend already has an authenticated task queue (`GET /api/agent/tasks`) and task-result endpoint, but the Android app does not execute those tasks.

## Runtime target

- Minecraft 1.21.11 requires Java 21.
- The first Android target should be `arm64-v8a`; the app must inspect `Build.SUPPORTED_ABIS` at runtime rather than assume a device ABI.
- The candidate headless OpenJDK 21 Android runtime from NLauncher declares Android API 29+ and is explicitly marked experimental. Its release archive includes a SHA-256 digest and corresponding source bundle. It is a candidate for device evaluation, not an approved production dependency.
- The runtime must be installed in app-private storage and verified against a pinned SHA-256 digest before extraction. Archive extraction must reject absolute paths, path traversal, and links.

## Critical Android execution constraint

Do **not** implement the JVM by calling `ProcessBuilder(<filesDir>/.../bin/java)`. The candidate runtime's embedder notes explain that apps targeting API 29+ cannot execute files from their app data directory. Its `jspawnhelper` therefore cannot be relied on either.

The intended execution model is an in-process JVM created through JNI (`JNI_CreateJavaVM`) from a native Android library. The bridge must:
1. Load the verified runtime libraries from the app-private runtime directory.
2. Set writable `TMPDIR`, `java.io.tmpdir`, `user.home`, timezone, and headless properties.
3. Configure Android DNS support if required by the runtime.
4. Create one managed JVM and run the Minecraft server bootstrap on a dedicated worker thread.
5. Stream stdout/stderr and console input through a bounded, lifecycle-aware bridge.
6. Shut down the server cleanly and destroy the VM only after the server process lifecycle has ended.

When using an in-process HotSpot VM on Android 11+, evaluate the runtime's heap-tagging note and set `android:allowNativeHeapPointerTagging="false"` before enabling JNI VM creation. Do not change this manifest flag until the native integration is actually present and tested.

## JNI bootstrap foundation (implemented, not yet device-validated)\n\n- The Android module now builds a small native library and exposes `EmbeddedJvm.nativeStart(...)`.\n- The bridge loads `<runtimeRoot>/lib/server/libjvm.so`, calls `JNI_CreateJavaVM` in-process, and reads `java.version` as a smoke-test result.\n- The app is restricted to `arm64-v8a` and `minSdk 29` for this experimental runtime path. The manifest disables native heap pointer tagging as required by the candidate embedder notes.\n- This is only a bootstrap foundation: no runtime archive is downloaded or installed yet, no pinned runtime checksum is configured, no device test has passed, and no Minecraft server is launched. Keep `minecraftRuntime=false`.\n\n## App and backend integration sequence

1. Add runtime compatibility detection (API level, ABI, free storage) and a clear unsupported-device state.
2. Add a verified runtime installer with progress, cancellation, staging extraction, and atomic activation.
3. Add the JNI bridge and test `java -version` in-process before enabling any server tasks.
4. Add the Android server process manager: provision, start, stop, restart, logs, and bounded console commands.
5. Integrate the existing DragonHost task polling/result API.
6. Only then advertise `minecraftRuntime=true` in heartbeats.

## Safety and reliability gates

- Keep `minecraftRuntime=false` until a real device test passes.
- Never report a server as online merely because a task was queued or the JVM started; wait for the Minecraft `Done` startup marker and a successful status probe.
- Keep each server's working directory isolated under app-private storage and validate every server ID before resolving paths.
- Do not expose arbitrary shell execution or unrestricted filesystem paths through the web console.
- Account for Android background execution limits, thermal load, battery drain, storage requirements, and carrier/router NAT. A phone-hosted server is not equivalent to a cloud host.
- Review OpenJDK and third-party component licenses and ship the matching source/notices before distributing an APK.

## Current implementation boundary

No runtime is bundled, no JVM is launched, and no Minecraft task is executed by this design document. The existing Node.js/Termux/Linux agent remains the only implemented server execution path. Android runtime work must proceed in separately testable steps.
