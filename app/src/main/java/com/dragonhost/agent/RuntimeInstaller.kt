package com.dragonhost.agent

import android.content.Context
import android.system.Os
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.tukaani.xz.XZInputStream
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * Downloads a pinned OpenJDK 21 Android runtime, verifies it before extraction,
 * rejects archive links/path traversal, and activates it from app-private storage.
 */
object RuntimeInstaller {
    private const val RELEASE_TAG = "jre21-21.0.12.8-nl1"
    private const val FILE_NAME = "jre21-android-arm64.tar.xz"
    private const val SHA256 = "60f96068aa26f8d36241de8ff82b13484ee3a4c2033bda6aa1a0008fef7ff869"
    private const val DOWNLOAD_URL =
        "https://github.com/Unxkki/nlauncher-jre-android/releases/download/$RELEASE_TAG/$FILE_NAME"
    private const val MAX_ARCHIVE_BYTES = 150L * 1024L * 1024L
    private const val MAX_EXPANDED_BYTES = 1536L * 1024L * 1024L

    fun install(context: Context, progress: (String) -> Unit = {}): File {
        require(android.os.Build.VERSION.SDK_INT >= 29) {
            "يتطلب Android 10 أو أحدث"
        }
        require(android.os.Build.SUPPORTED_ABIS.any { it == "arm64-v8a" }) {
            "هذا الإصدار يتطلب معمارية arm64-v8a"
        }

        val availableBytes = android.os.StatFs(context.filesDir.absolutePath).availableBytes
        require(availableBytes >= 2L * 1024L * 1024L * 1024L) {
            "يلزم توفر 2 GB على الأقل في مساحة التطبيق لتثبيت Java بأمان"
        }

        val runtimeDir = File(context.filesDir, "runtimes/jre-21")
        if (isValidRuntime(runtimeDir)) return runtimeDir

        val parent = runtimeDir.parentFile ?: error("مسار التخزين غير صالح")
        check(parent.exists() || parent.mkdirs()) { "تعذر إنشاء مجلد runtime" }
        val archive = File(context.cacheDir, FILE_NAME)
        val staging = File(parent, "jre-21-staging")
        deleteRecursively(staging)
        if (archive.exists() && sha256(archive) != SHA256) archive.delete()

        if (!archive.exists()) {
            progress("جارٍ تنزيل Java 21...")
            download(archive, progress)
        }

        progress("جارٍ التحقق من سلامة الملف...")
        check(sha256(archive) == SHA256) {
            archive.delete()
            "فشل التحقق SHA-256؛ تم رفض ملف Java"
        }

        check(staging.mkdirs()) { "تعذر إنشاء مجلد التثبيت المؤقت" }
        try {
            progress("جارٍ فك ضغط Java 21...")
            extractSafely(archive, staging, progress)
            val stagedRuntime = File(staging, "jre-21")
            check(isValidRuntime(stagedRuntime)) {
                "ملفات Java غير مكتملة أو الإصدار ليس Java 21"
            }

            if (runtimeDir.exists()) deleteRecursively(runtimeDir)
            check(stagedRuntime.renameTo(runtimeDir)) {
                "تعذر تفعيل Java 21 داخل التطبيق"
            }
            progress("تم تثبيت Java 21 والتحقق من ملفاتها")
            return runtimeDir
        } finally {
            deleteRecursively(staging)
            archive.delete()
        }
    }

    fun installedRuntime(context: Context): File? {
        val runtime = File(context.filesDir, "runtimes/jre-21")
        return runtime.takeIf { isValidRuntime(it) }
    }

    private fun download(destination: File, progress: (String) -> Unit) {
        val connection = (URL(DOWNLOAD_URL).openConnection() as HttpURLConnection).apply {
            instanceFollowRedirects = true
            connectTimeout = 20000
            readTimeout = 30000
            requestMethod = "GET"
            setRequestProperty("User-Agent", "DragonHost-Agent")
        }
        try {
            val code = connection.responseCode
            check(code == HttpURLConnection.HTTP_OK) { "فشل تنزيل Java (HTTP $code)" }
            val length = connection.contentLengthLong
            check(length <= 0L || length <= MAX_ARCHIVE_BYTES) { "حجم ملف Java أكبر من الحد المسموح" }
            connection.inputStream.buffered().use { input ->
                FileOutputStream(destination).buffered().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    var total = 0L
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        total += count
                        check(total <= MAX_ARCHIVE_BYTES) { "تجاوز التنزيل الحد المسموح" }
                        output.write(buffer, 0, count)
                        if (total % (1024L * 1024L) < buffer.size) {
                            progress("جارٍ تنزيل Java 21: ${total / (1024 * 1024)} MB")
                        }
                    }
                    output.flush()
                }
            }
        } finally {
            connection.disconnect()
        }
    }

    private fun extractSafely(archive: File, destination: File, progress: (String) -> Unit) {
        var expanded = 0L
        val root = destination.canonicalFile
        TarArchiveInputStream(
            XZInputStream(BufferedInputStream(FileInputStream(archive)))
        ).use { tar ->
            while (true) {
                val entry = tar.nextTarEntry ?: break
                val name = entry.name.replace('\\', '/')
                check(!name.startsWith("/") && !name.split('/').contains("..")) {
                    "الأرشيف يحتوي على مسار غير آمن"
                }
                check(name == "jre-21" || name.startsWith("jre-21/")) {
                    "الأرشيف يحتوي على مجلد غير متوقع"
                }
                check(!entry.isLink) {
                    "الأرشيف يحتوي على رابط صلب غير مدعوم"
                }

                val output = File(destination, name).canonicalFile
                check(output.path == root.path || output.path.startsWith(root.path + File.separator)) {
                    "تم رفض مسار خارج مجلد التثبيت"
                }
                if (entry.isSymbolicLink) {
                    val linkName = entry.linkName.replace('\\', '/')
                    check(linkName.isNotBlank() && !linkName.startsWith("/")) {
                        "الأرشيف يحتوي على رابط رمزي غير آمن"
                    }
                    val target = output.parentFile.toPath().resolve(linkName).normalize()
                    check(target.startsWith(root.toPath())) {
                        "الرابط الرمزي يشير إلى خارج مجلد Java"
                    }
                    val parent = output.parentFile ?: error("مسار الرابط غير صالح")
                    check(parent.isDirectory || parent.mkdirs()) { "تعذر إنشاء مجلد الرابط" }
                    check(!output.exists() && !java.nio.file.Files.isSymbolicLink(output.toPath())) {
                        "مسار الرابط موجود مسبقاً"
                    }
                    Os.symlink(linkName, output.absolutePath)
                } else if (entry.isDirectory) {
                    check(output.isDirectory || output.mkdirs()) { "تعذر إنشاء مجلد Java" }
                } else if (entry.isFile) {
                    expanded += entry.size
                    check(expanded <= MAX_EXPANDED_BYTES) { "حجم فك الضغط تجاوز الحد المسموح" }
                    val parent = output.parentFile ?: error("مسار ملف غير صالح")
                    check(parent.isDirectory || parent.mkdirs()) { "تعذر إنشاء مجلد الملف" }
                    BufferedOutputStream(FileOutputStream(output)).use { out ->
                        val buffer = ByteArray(64 * 1024)
                        while (true) {
                            val count = tar.read(buffer)
                            if (count < 0) break
                            out.write(buffer, 0, count)
                        }
                    }
                } else {
                    error("نوع ملف غير مدعوم داخل runtime")
                }
            }
        }
        progress("اكتمل فك ضغط ملفات Java")
    }

    private fun isValidRuntime(directory: File): Boolean {
        if (!directory.isDirectory) return false
        val required = listOf(
            "bin/java",
            "lib/server/libjvm.so",
            "lib/modules",
            "release",
            "NLAUNCHER-BUILD.txt"
        )
        if (!required.all { File(directory, it).isFile }) return false
        val release = runCatching { File(directory, "release").readText() }.getOrNull() ?: return false
        return Regex("JAVA_VERSION=\\\"21\\.[^\\\"]+\\\"").containsMatchIn(release)
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).buffered().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private fun deleteRecursively(file: File) {
        if (file.isDirectory) file.listFiles()?.forEach(::deleteRecursively)
        if (file.exists()) file.delete()
    }
}
