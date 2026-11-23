package com.dragonhost.agent

import android.content.Context
import android.os.Build
import android.os.StatFs
import java.util.Locale

data class RuntimeCompatibility(
    val androidApi: Int,
    val primaryAbi: String,
    val arm64Supported: Boolean,
    val minimumApiSupported: Boolean,
    val freeStorageBytes: Long
) {
    val hasEnoughStorage: Boolean
        get() = freeStorageBytes >= 2L * 1024L * 1024L * 1024L

    val canEvaluateCandidateRuntime: Boolean
        get() = arm64Supported && minimumApiSupported && hasEnoughStorage

    fun summary(): String {
        val storageGb = freeStorageBytes.toDouble() / (1024.0 * 1024.0 * 1024.0)
        val abiState = if (arm64Supported) "مدعوم مبدئياً" else "غير مدعوم حالياً"
        val apiState = if (minimumApiSupported) "مناسب للحد الأدنى" else "يتطلب Android 10 أو أحدث"
        val storageState = if (hasEnoughStorage) "المساحة المتاحة كافية مبدئياً" else "يلزم توفر 2 GB على الأقل قبل تنزيل Java"
        val evaluationState = if (canEvaluateCandidateRuntime) {
            "يمكن الانتقال إلى اختبار توافق Java 21"
        } else {
            "لا يمكن تثبيت runtime المرشح على هذا الجهاز"
        }
        return String.format(
            Locale.US,
            "فحص توافق Java 21 (أولي):\nAndroid API: %d (%s)\nالمعمارية: %s — %s\nالمساحة الحرة: %.2f GB\n%s\nهذا الفحص لا يعني أن Minecraft أصبح قابلاً للتشغيل بعد.",
            androidApi, apiState, primaryAbi, abiState, storageGb, storageState, evaluationState
        )
    }

    companion object {
        fun inspect(context: Context): RuntimeCompatibility {
            val stats = StatFs(context.filesDir.absolutePath)
            val abis = Build.SUPPORTED_ABIS.toList()
            return RuntimeCompatibility(
                androidApi = Build.VERSION.SDK_INT,
                primaryAbi = abis.firstOrNull() ?: "unknown",
                arm64Supported = abis.contains("arm64-v8a"),
                minimumApiSupported = Build.VERSION.SDK_INT >= 29,
                freeStorageBytes = stats.availableBytes
            )
        }
    }
}
