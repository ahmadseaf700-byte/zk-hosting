package com.dragonhost.agent

import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity() {
    private val executor = Executors.newSingleThreadExecutor()
    private lateinit var status: TextView
    private lateinit var codeInput: EditText
    private lateinit var urlInput: EditText
    private lateinit var pairButton: Button

    private fun securePrefs() = EncryptedSharedPreferences.create(
        this,
        "dragonhost_secure",
        MasterKey.Builder(this).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = securePrefs()
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(28, 36, 28, 24)
            setBackgroundColor(0xFF101820.toInt())
            layoutDirection = View.LAYOUT_DIRECTION_RTL
        }
        root.addView(TextView(this).apply {
            text = "🐉 DragonHost Agent"
            textSize = 27f
            setTextColor(0xFFFFFFFF.toInt())
            gravity = Gravity.CENTER
        }, matchWrap())
        root.addView(TextView(this).apply {
            text = "اربط هاتفك بمنصة DragonHost"
            textSize = 16f
            setTextColor(0xFFB8C5CE.toInt())
            gravity = Gravity.CENTER
            setPadding(0, 14, 0, 28)
        }, matchWrap())
        status = TextView(this).apply {
            text = if (prefs.contains("token")) "يوجد حساب مربوط بهذا الجهاز" else "الجهاز غير مربوط"
            textSize = 15f
            setTextColor(0xFF7FE0A8.toInt())
            gravity = Gravity.CENTER
            setPadding(0, 8, 0, 18)
        }
        root.addView(status, matchWrap())
        urlInput = EditText(this).apply {
            hint = "رابط DragonHost"
            setSingleLine(true)
            setText(prefs.getString("url", "https://dragonhost-mb5d.onrender.com"))
            textDirection = View.TEXT_DIRECTION_LTR
        }
        root.addView(urlInput, matchWrap())
        codeInput = EditText(this).apply {
            hint = "رمز الربط المكوّن من 6 أرقام"
            setSingleLine(true)
            inputType = android.text.InputType.TYPE_CLASS_NUMBER
            gravity = Gravity.CENTER
            textSize = 20f
        }
        root.addView(codeInput, matchWrap())
        pairButton = Button(this).apply {
            text = "ربط الجهاز"
            setOnClickListener { pairDevice() }
        }
        root.addView(pairButton, matchWrap().apply { topMargin = 18 })
        root.addView(TextView(this).apply {
            text = "نسخة أولية: الربط فقط حالياً. تشغيل Minecraft يحتاج دمج Java Runtime واختباره على Android."
            textSize = 13f
            setTextColor(0xFFFFD18A.toInt())
            setPadding(0, 28, 0, 0)
            gravity = Gravity.CENTER
        }, matchWrap())
        setContentView(root)
    }

    private fun matchWrap() = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT
    )

    private fun pairDevice() {
        val code = codeInput.text.toString().trim()
        val baseUrl = urlInput.text.toString().trim().trimEnd('/')
        if (!code.matches(Regex("\\d{6}"))) {
            status.text = "أدخل رمز ربط صحيحاً من 6 أرقام"
            return
        }
        if (!baseUrl.startsWith("https://")) {
            status.text = "استخدم رابطاً آمناً يبدأ بـ https://"
            return
        }
        pairButton.isEnabled = false
        status.text = "جارٍ ربط الجهاز..."
        executor.execute {
            try {
                val connection = URL(baseUrl + "/api/agent/pair").openConnection() as HttpURLConnection
                connection.requestMethod = "POST"
                connection.connectTimeout = 15000
                connection.readTimeout = 20000
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                val payload = JSONObject().put("code", code)
                    .put("deviceName", android.os.Build.MODEL).toString()
                connection.outputStream.use { it.write(payload.toByteArray(StandardCharsets.UTF_8)) }
                val responseCode = connection.responseCode
                val stream = if (responseCode in 200..299) connection.inputStream else connection.errorStream
                val body = stream.bufferedReader().use { it.readText() }
                if (responseCode !in 200..299) {
                    val message = runCatching { JSONObject(body).optString("error") }
                        .getOrDefault("HTTP " + responseCode)
                    throw IllegalStateException(message)
                }
                val token = JSONObject(body).getString("token")
                securePrefs().edit().putString("token", token).putString("url", baseUrl).apply()
                connection.disconnect()
                runOnUiThread {
                    status.text = "تم ربط الجهاز بنجاح ✅"
                    codeInput.text.clear()
                    pairButton.isEnabled = true
                }
            } catch (error: Exception) {
                runOnUiThread {
                    status.text = "فشل الربط: " + (error.message ?: "خطأ غير معروف")
                    pairButton.isEnabled = true
                }
            }
        }
    }

    override fun onDestroy() {
        executor.shutdownNow()
        super.onDestroy()
    }
}
