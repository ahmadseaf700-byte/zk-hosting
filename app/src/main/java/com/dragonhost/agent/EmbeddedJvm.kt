package com.dragonhost.agent

/**
 * Minimal in-process HotSpot bootstrap.
 *
 * The runtime must be installed and SHA-256 verified before calling start().
 * This class deliberately does not launch Minecraft or advertise runtime capability.
 */
class EmbeddedJvm {
    companion object {
        init {
            System.loadLibrary("dragonhost_jvm")
        }
    }

    external fun nativeStart(
        runtimeRoot: String,
        tempDirectory: String,
        homeDirectory: String
    ): String
}
