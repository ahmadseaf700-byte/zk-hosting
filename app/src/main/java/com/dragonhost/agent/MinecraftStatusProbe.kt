package com.dragonhost.agent

import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.net.InetSocketAddress
import java.net.Socket

/** Uses the Minecraft status handshake, not merely an open TCP-port check. */
object MinecraftStatusProbe {
    fun check(host: String = "127.0.0.1", port: Int = 25565): JSONObject? = runCatching {
        Socket().use { socket ->
            socket.connect(InetSocketAddress(host, port), 1200)
            socket.soTimeout = 1800
            val output = DataOutputStream(BufferedOutputStream(socket.getOutputStream()))
            val input = DataInputStream(BufferedInputStream(socket.getInputStream()))

            val handshake = java.io.ByteArrayOutputStream()
            val handshakeData = DataOutputStream(handshake)
            writeVarInt(handshakeData, 0) // Handshake packet
            writeVarInt(handshakeData, -1) // Unknown protocol is accepted for status requests
            writeString(handshakeData, host)
            handshakeData.writeShort(port)
            writeVarInt(handshakeData, 1) // Status state
            writePacket(output, handshake.toByteArray())

            val request = java.io.ByteArrayOutputStream()
            val requestData = DataOutputStream(request)
            writeVarInt(requestData, 0) // Status request
            writePacket(output, request.toByteArray())
            output.flush()

            val packetLength = readVarInt(input)
            require(packetLength in 1..1_048_576) { "Invalid status packet length" }
            val packetId = readVarInt(input)
            require(packetId == 0) { "Unexpected status packet" }
            val jsonLength = readVarInt(input)
            require(jsonLength in 2..packetLength) { "Invalid status JSON length" }
            val jsonBytes = ByteArray(jsonLength)
            input.readFully(jsonBytes)
            JSONObject(String(jsonBytes, Charsets.UTF_8))
        }.takeIf { it.has("version") && it.has("players") }
    }.getOrNull()

    private fun writePacket(output: DataOutputStream, payload: ByteArray) {
        writeVarInt(output, payload.size)
        output.write(payload)
    }

    private fun writeString(output: DataOutputStream, value: String) {
        val bytes = value.toByteArray(Charsets.UTF_8)
        writeVarInt(output, bytes.size)
        output.write(bytes)
    }

    private fun writeVarInt(output: DataOutputStream, raw: Int) {
        var value = raw
        while (value and -128 != 0) {
            output.writeByte((value and 127) or 128)
            value = value ushr 7
        }
        output.writeByte(value)
    }

    private fun readVarInt(input: DataInputStream): Int {
        var value = 0
        var position = 0
        while (position < 35) {
            val current = input.readUnsignedByte()
            value = value or ((current and 127) shl position)
            if (current and 128 == 0) return value
            position += 7
        }
        error("VarInt is too large")
    }
}
