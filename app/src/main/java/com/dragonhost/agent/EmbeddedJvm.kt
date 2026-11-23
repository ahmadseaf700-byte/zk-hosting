package com.dragonhost.agent

/**
 * JNI bridge to the embedded Java 21 VM.
 * The JVM must be started successfully before server methods are called.
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

    /** Blocks until the server main method exits; call from a dedicated worker thread. */
    external fun nativeLaunchServer(jarPath: String, workingDirectory: String): String

    /** Sends a single console command to the embedded server's standard input. */
    external fun nativeSendServerCommand(command: String): String
}
