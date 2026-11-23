package com.dragonhost.agent

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.UUID

/**
 * Prepares an isolated Java Edition server workspace.
 * This class downloads files only; it does not launch Minecraft.
 */
class ServerWorkspace(private val context: Context) {
    data class Config(
        val id: String, val name: String, val version: String, val software: String,
        val motd: String = name, val maxPlayers: Int = 20,
        val gamemode: String = "survival", val difficulty: String = "normal",
        val pvp: Boolean = true, val allowFlight: Boolean = false,
        val cracked: Boolean = false, val eulaAccepted: Boolean
    )
    data class Prepared(val directory: File, val jar: File, val version: String)

    fun prepare(config: Config, onProgress: (String) -> Unit = {}): Prepared {
        require(runCatching { UUID.fromString(config.id) }.isSuccess) { "معرّف السيرفر غير صالح" }
        require(config.eulaAccepted) { "يجب الموافقة على Minecraft EULA أولاً" }
        require(config.version.matches(Regex("\\d{1,2}\\.\\d{1,2}(\\.\\d{1,2})?"))) { "صيغة إصدار Minecraft غير صحيحة" }
        require(config.maxPlayers in 1..100) { "عدد اللاعبين يجب أن يكون بين 1 و100" }
        require(config.software in setOf("vanilla", "purpur")) { "النسخة الأولى تدعم Vanilla وPurpur فقط" }

        val root = File(context.filesDir, "minecraft-servers").canonicalFile
        if (!root.exists() && !root.mkdirs()) error("تعذر إنشاء مجلد السيرفرات")
        val directory = File(root, config.id).canonicalFile
        require(directory.parentFile == root) { "مسار السيرفر غير آمن" }
        if (!directory.exists() && !directory.mkdirs()) error("تعذر إنشاء مجلد السيرفر")

        val jar = File(directory, "server.jar")
        if (!jar.isFile || jar.length() == 0L) {
            val temporary = File(directory, "server.jar.part")
            temporary.delete()
            onProgress("جارٍ تنزيل ملفات " + config.software + " " + config.version + "...")
            val source = resolveDownload(config, onProgress)
            download(source.first, temporary, source.second, onProgress)
            if (!temporary.renameTo(jar)) {
                temporary.delete()
                error("تعذر تثبيت ملف السيرفر بعد التنزيل")
            }
        }
        File(directory, "eula.txt").writeText("eula=true\n")
        File(directory, "server.properties").writeText(buildProperties(config))
        return Prepared(directory, jar, config.version)
    }

    private fun resolveDownload(config: Config, onProgress: (String) -> Unit): Pair<String, String?> {
        if (config.software == "purpur") {
            return "https://api.purpurmc.org/v2/purpur/" + config.version + "/latest/download" to null
        }
        onProgress("جارٍ جلب بيانات الإصدار الرسمي...")
        val manifest = JSONObject(readUrl("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"))
        val versions = manifest.getJSONArray("versions")
        var metadataUrl: String? = null
        for (index in 0 until versions.length()) {
            val item = versions.getJSONObject(index)
            if (item.optString("id") == config.version) {
                metadataUrl = item.optString("url")
                break
            }
        }
        val metadata = JSONObject(readUrl(metadataUrl ?: error("إصدار Minecraft غير موجود في القائمة الرسمية")))
        val server = metadata.getJSONObject("downloads").getJSONObject("server")
        return server.getString("url") to server.optString("sha1").takeIf { it.isNotBlank() }
    }

    private fun readUrl(address: String): String {
        val connection = (URL(address).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15000
            readTimeout = 30000
            setRequestProperty("User-Agent", "DragonHost-Agent/0.2")
        }
        try {
            if (connection.responseCode !in 200..299) error("فشل طلب البيانات: HTTP " + connection.responseCode)
            return connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
        } finally { connection.disconnect() }
    }

    private fun download(address: String, destination: File, expectedSha1: String?, onProgress: (String) -> Unit) {
        val connection = (URL(address).openConnection() as HttpURLConnection).apply {
            connectTimeout = 20000
            readTimeout = 60000
            instanceFollowRedirects = true
            setRequestProperty("User-Agent", "DragonHost-Agent/0.2")
        }
        try {
            if (connection.responseCode !in 200..299) error("فشل تنزيل ملف السيرفر: HTTP " + connection.responseCode)
            val declared = connection.contentLengthLong
            require(declared <= MAX_JAR_BYTES || declared < 0) { "حجم ملف السيرفر أكبر من الحد المسموح" }
            val digest = MessageDigest.getInstance("SHA-1")
            var total = 0L
            onProgress("بدأ تنزيل ملف السيرفر...")
            connection.inputStream.use { input ->
                destination.outputStream().buffered().use { output ->
                    val buffer = ByteArray(65536)
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        total += count
                        require(total <= MAX_JAR_BYTES) { "تجاوز ملف السيرفر الحد الأقصى للحجم" }
                        digest.update(buffer, 0, count)
                        output.write(buffer, 0, count)
                    }
                }
            }
            require(total > 1024 * 1024) { "ملف السيرفر الذي تم تنزيله غير مكتمل" }
            if (expectedSha1 != null) {
                val actual = digest.digest().joinToString("") { "%02x".format(it) }
                require(actual.equals(expectedSha1, ignoreCase = true)) { "فشل التحقق من سلامة ملف السيرفر" }
            }
            onProgress("اكتمل تنزيل ملف السيرفر والتحقق منه.")
        } catch (error: Exception) {
            destination.delete()
            throw error
        } finally { connection.disconnect() }
    }

    private fun buildProperties(config: Config): String {
        fun clean(value: String) = value.replace(Regex("[\\r\\n]"), " ").replace("=", "\\=")
        return listOf(
            "server-ip=0.0.0.0", "server-port=25565",
            "motd=" + clean(config.motd), "max-players=" + config.maxPlayers,
            "gamemode=" + config.gamemode, "difficulty=" + config.difficulty,
            "online-mode=" + (!config.cracked), "allow-flight=" + config.allowFlight,
            "pvp=" + config.pvp, "enable-rcon=false",
            "view-distance=6", "simulation-distance=4"
        ).joinToString("\n", postfix = "\n")
    }

    companion object {
        private const val MAX_JAR_BYTES = 1500L * 1024L * 1024L
    }
}
