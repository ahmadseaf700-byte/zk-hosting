package com.dragonhost.agent

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class AgentService : Service() {
    private val executor = Executors.newSingleThreadExecutor()
    private val running = AtomicBoolean(false)
    private val channelId = "dragonhost_agent_status"

    private fun securePrefs() = EncryptedSharedPreferences.create(
        this,
        "dragonhost_secure",
        MasterKey.Builder(this).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        startForeground(41, notification("جارٍ تجهيز اتصال DragonHost..."))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (running.compareAndSet(false, true)) {
            executor.execute { heartbeatLoop() }
        }
        return START_STICKY
    }

    private fun heartbeatLoop() {
        while (running.get()) {
            try {
                val prefs = securePrefs()
                val token = prefs.getString("token", null)
                    ?: throw IllegalStateException("اربط الجهاز من التطبيق أولاً")
                val baseUrl = prefs.getString("url", null)
                    ?: throw IllegalStateException("رابط DragonHost غير محفوظ")
                val connection = URL(baseUrl.trimEnd('/') + "/api/agent/heartbeat")
                    .openConnection() as HttpURLConnection
                connection.requestMethod = "POST"
                connection.connectTimeout = 10000
                connection.readTimeout = 10000
                connection.doOutput = true
                connection.setRequestProperty("Authorization", "Bearer " + token)
                connection.setRequestProperty("Content-Type", "application/json")
                val payload = JSONObject()
                    .put("deviceName", Build.MODEL)
                    .put("platform", "android")
                    .put("agentVersion", "0.2.0")
                    .put("minecraftRuntime", false)
                connection.outputStream.use { it.write(payload.toString().toByteArray(Charsets.UTF_8)) }
                val code = connection.responseCode
                if (code !in 200..299) throw IllegalStateException("HTTP $code")
                connection.inputStream.close()
                connection.disconnect()
                updateNotification("الهاتف متصل بـ DragonHost ✓ — محرك Minecraft غير مدمج بعد")
            } catch (error: Exception) {
                updateNotification("الاتصال غير متاح: " + (error.message ?: "خطأ"))
            }
            try { Thread.sleep(15000) } catch (_: InterruptedException) { break }
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                channelId, "DragonHost Agent", NotificationManager.IMPORTANCE_LOW
            )
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    private fun notification(message: String): Notification {
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, channelId)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setContentTitle("DragonHost Agent")
            .setContentText(message)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .build()
    }

    private fun updateNotification(message: String) {
        getSystemService(NotificationManager::class.java).notify(41, notification(message))
    }

    override fun onDestroy() {
        running.set(false)
        executor.shutdownNow()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val ACTION_STOP = "com.dragonhost.agent.STOP"
    }
}
