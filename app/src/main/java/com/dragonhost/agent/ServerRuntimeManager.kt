package com.dragonhost.agent

import android.content.Context
import android.os.Handler
import android.os.Looper
import java.io.File
import java.util.concurrent.atomic.AtomicReference

/**
 * Owns the first single-server-per-phone launch lifecycle.
 * Experimental in-process runner; the caller must keep a foreground service alive.
 */
class ServerRuntimeManager(context: Context) {
    enum class State { STOPPED, STARTING, RUNNING, STOPPING, FAILED }

    private val appContext = context.applicationContext
    private val jvm = EmbeddedJvm()
    private val state = AtomicReference(State.STOPPED)
    private val mainHandler = Handler(Looper.getMainLooper())
    @Volatile private var worker: Thread? = null
    @Volatile private var lastResult: String = "لم يبدأ السيرفر"

    fun currentState(): State = state.get()
    fun lastResult(): String = lastResult

    @Synchronized
    fun start(
        prepared: ServerWorkspace.Prepared,
        eulaAccepted: Boolean,
        onStatus: (State, String) -> Unit = { _, _ -> }
    ) {
        check(eulaAccepted) { "يجب أن توافق على Minecraft EULA بنفسك قبل التشغيل" }
        check(state.get() == State.STOPPED || state.get() == State.FAILED) {
            "يوجد سيرفر قيد التشغيل أو التجهيز على هذا الهاتف"
        }
        check(worker?.isAlive != true) { "عملية تشغيل سابقة لم تنتهِ بعد" }

        val serversRoot = File(appContext.filesDir, "minecraft-servers").canonicalFile
        val directory = prepared.directory.canonicalFile
        val jar = prepared.jar.canonicalFile
        check(directory.parentFile == serversRoot) { "مجلد السيرفر خارج مساحة DragonHost" }
        check(jar.parentFile == directory && jar.name == "server.jar" && jar.isFile) {
            "ملف server.jar غير موجود في مساحة السيرفر"
        }
        check(jar.length() > 1024 * 1024) { "ملف server.jar غير مكتمل" }

        state.set(State.STARTING)
        notify(onStatus, State.STARTING, "جارٍ تهيئة Java 21...")
        val runtimeRoot = File(appContext.filesDir, "runtimes/jre-21").canonicalPath
        val jvmResult = jvm.nativeStart(
            runtimeRoot,
            appContext.cacheDir.canonicalPath,
            appContext.filesDir.canonicalPath
        )
        check(jvmResult.startsWith("JVM_STARTED:21") || jvmResult == "ALREADY_RUNNING") {
            state.set(State.FAILED)
            lastResult = jvmResult
            notify(onStatus, State.FAILED, "فشل تشغيل Java: $jvmResult")
            "تعذر تشغيل Java 21: $jvmResult"
        }

        worker = Thread({
            notify(onStatus, State.STARTING, "جارٍ تشغيل محرك Minecraft...")
            val result = runCatching {
                jvm.nativeLaunchServer(jar.absolutePath, directory.absolutePath)
            }.getOrElse { "ERROR:" + (it.message ?: it.javaClass.simpleName) }
            lastResult = result
            val next = if (result == "SERVER_EXITED") State.STOPPED else State.FAILED
            state.set(next)
            notify(
                onStatus,
                next,
                if (next == State.STOPPED) "توقف السيرفر." else "تعذر تشغيل السيرفر: $result"
            )
        }, "DragonHost-Minecraft-" + directory.name).apply {
            isDaemon = false
            start()
        }
    }

    fun sendCommand(command: String): String {
        require(command.isNotBlank() && command.length <= 256)
        require(!command.contains('\n') && !command.contains('\r'))
        check(state.get() == State.RUNNING || state.get() == State.STARTING) {
            "السيرفر ليس في حالة تسمح بإرسال الأوامر"
        }
        return jvm.nativeSendServerCommand(command)
    }

    fun stop(): String {
        val current = state.get()
        check(current == State.RUNNING || current == State.STARTING) {
            "لا يوجد سيرفر يعمل حالياً"
        }
        state.set(State.STOPPING)
        val result = jvm.nativeSendServerCommand("stop")
        lastResult = result
        return result
    }

    private fun notify(callback: (State, String) -> Unit, newState: State, message: String) {
        mainHandler.post { callback(newState, message) }
    }
}
