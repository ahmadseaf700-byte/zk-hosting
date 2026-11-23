#include <jni.h>
#include <dlfcn.h>
#include <android/log.h>
#include <cstdlib>
#include <mutex>
#include <string>
#include <atomic>
#include <unistd.h>

#ifndef JNI_VERSION_1_8
#define JNI_VERSION_1_8 0x00010008
#endif

#define LOG_TAG "DragonHostJVM"
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace {
std::mutex g_mutex;
std::mutex g_server_mutex;
JavaVM* g_vm = nullptr;
void* g_jvm_handle = nullptr;
jobject g_server_input = nullptr;
std::atomic<bool> g_server_running{false};

using CreateJavaVm = jint (JNICALL *)(JavaVM**, void**, void*);

std::string fromJava(JNIEnv* env, jstring value) {
    if (!value) return {};
    const char* chars = env->GetStringUTFChars(value, nullptr);
    if (!chars) return {};
    std::string result(chars);
    env->ReleaseStringUTFChars(value, chars);
    return result;
}

std::string readJavaVersion(JNIEnv* env) {
    jclass systemClass = env->FindClass("java/lang/System");
    if (!systemClass) return "JVM_STARTED_VERSION_UNKNOWN";
    jmethodID getProperty = env->GetStaticMethodID(
        systemClass, "getProperty", "(Ljava/lang/String;)Ljava/lang/String;");
    if (!getProperty) return "JVM_STARTED_VERSION_UNKNOWN";
    jstring key = env->NewStringUTF("java.version");
    auto value = static_cast<jstring>(env->CallStaticObjectMethod(systemClass, getProperty, key));
    if (env->ExceptionCheck()) {
        env->ExceptionClear();
        return "JVM_STARTED_VERSION_UNKNOWN";
    }
    if (!value) return "JVM_STARTED_VERSION_UNKNOWN";
    const char* chars = env->GetStringUTFChars(value, nullptr);
    if (!chars) return "JVM_STARTED_VERSION_UNKNOWN";
    std::string result(chars);
    env->ReleaseStringUTFChars(value, chars);
    return result;
}

JNIEnv* attachEmbedded(bool* attached) {
    *attached = false;
    if (!g_vm) return nullptr;
    JNIEnv* env = nullptr;
    jint state = g_vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_8);
    if (state == JNI_OK) return env;
    if (state != JNI_EDETACHED) return nullptr;
    if (g_vm->AttachCurrentThread(&env, nullptr) != JNI_OK) return nullptr;
    *attached = true;
    return env;
}
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_dragonhost_agent_EmbeddedJvm_nativeStart(
    JNIEnv* env, jobject /* thiz */, jstring runtimeRootValue,
    jstring tempDirValue, jstring homeDirValue) {
    std::lock_guard<std::mutex> lock(g_mutex);
    if (g_vm) return env->NewStringUTF("ALREADY_RUNNING");

    const std::string runtimeRoot = fromJava(env, runtimeRootValue);
    const std::string tempDir = fromJava(env, tempDirValue);
    const std::string homeDir = fromJava(env, homeDirValue);
    if (runtimeRoot.empty() || tempDir.empty() || homeDir.empty())
        return env->NewStringUTF("ERROR:INVALID_PATH_ARGUMENT");

    const std::string libraryPath = runtimeRoot + "/lib/server/libjvm.so";
    setenv("TMPDIR", tempDir.c_str(), 1);

    g_jvm_handle = dlopen(libraryPath.c_str(), RTLD_NOW | RTLD_GLOBAL);
    if (!g_jvm_handle) {
        LOGE("dlopen failed: %s", dlerror());
        return env->NewStringUTF("ERROR:JVM_LIBRARY_LOAD_FAILED");
    }

    auto createVm = reinterpret_cast<CreateJavaVm>(dlsym(g_jvm_handle, "JNI_CreateJavaVM"));
    if (!createVm) {
        LOGE("JNI_CreateJavaVM symbol missing: %s", dlerror());
        dlclose(g_jvm_handle);
        g_jvm_handle = nullptr;
        return env->NewStringUTF("ERROR:JNI_CREATE_VM_MISSING");
    }

    const std::string javaHome = "-Djava.home=" + runtimeRoot;
    const std::string javaTmp = "-Djava.io.tmpdir=" + tempDir;
    const std::string userHome = "-Duser.home=" + homeDir;
    const std::string dnsConfig = "-Djdk.android.resolvConf=" + homeDir + "/resolv.conf";
    const std::string timezone = "-Duser.timezone=UTC";
    JavaVMOption options[8]{};
    options[0].optionString = const_cast<char*>(javaHome.c_str());
    options[1].optionString = const_cast<char*>(javaTmp.c_str());
    options[2].optionString = const_cast<char*>(userHome.c_str());
    options[3].optionString = const_cast<char*>("-Djava.awt.headless=true");
    options[4].optionString = const_cast<char*>("-XX:-UsePerfData");
    options[5].optionString = const_cast<char*>("-XX:-UseContainerSupport");
    options[6].optionString = const_cast<char*>(dnsConfig.c_str());
    options[7].optionString = const_cast<char*>(timezone.c_str());

    JavaVMInitArgs args{};
    args.version = JNI_VERSION_1_8;
    args.nOptions = 8;
    args.options = options;
    args.ignoreUnrecognized = JNI_FALSE;

    JNIEnv* vmEnv = nullptr;
    const jint result = createVm(&g_vm, reinterpret_cast<void**>(&vmEnv), &args);
    if (result != JNI_OK || !g_vm || !vmEnv) {
        LOGE("JNI_CreateJavaVM failed: %d", result);
        g_vm = nullptr;
        dlclose(g_jvm_handle);
        g_jvm_handle = nullptr;
        return env->NewStringUTF("ERROR:JNI_CREATE_VM_FAILED");
    }

    return env->NewStringUTF(("JVM_STARTED:" + readJavaVersion(vmEnv)).c_str());
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_dragonhost_agent_EmbeddedJvm_nativeLaunchServer(
    JNIEnv* callerEnv, jobject /* thiz */, jstring jarPathValue, jstring workingDirectoryValue) {
    if (!g_vm) return callerEnv->NewStringUTF("ERROR:JVM_NOT_STARTED");
    if (g_server_running.exchange(true)) return callerEnv->NewStringUTF("ERROR:SERVER_ALREADY_RUNNING");

    const std::string jarPath = fromJava(callerEnv, jarPathValue);
    const std::string workingDirectory = fromJava(callerEnv, workingDirectoryValue);
    if (jarPath.empty() || workingDirectory.empty()) {
        g_server_running = false;
        return callerEnv->NewStringUTF("ERROR:INVALID_SERVER_PATH");
    }

    bool attached = false;
    JNIEnv* env = attachEmbedded(&attached);
    if (!env) {
        g_server_running = false;
        return callerEnv->NewStringUTF("ERROR:EMBEDDED_VM_ATTACH_FAILED");
    }

    char previousDirectory[4096]{};
    const bool havePreviousDirectory = getcwd(previousDirectory, sizeof(previousDirectory)) != nullptr;
    if (chdir(workingDirectory.c_str()) != 0) {
        if (attached) g_vm->DetachCurrentThread();
        g_server_running = false;
        return callerEnv->NewStringUTF("ERROR:WORKING_DIRECTORY_FAILED");
    }

    jclass systemClass = env->FindClass("java/lang/System");
    jmethodID setProperty = env->GetStaticMethodID(
        systemClass, "setProperty",
        "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;");
    jstring userDirKey = env->NewStringUTF("user.dir");
    jstring userDirValue = env->NewStringUTF(workingDirectory.c_str());
    env->CallStaticObjectMethod(systemClass, setProperty, userDirKey, userDirValue);

    // Pipe console input so the Android app can send the normal "stop" command.
    jclass pipedInputClass = env->FindClass("java/io/PipedInputStream");
    jclass pipedOutputClass = env->FindClass("java/io/PipedOutputStream");
    jmethodID inputCtor = env->GetMethodID(pipedInputClass, "<init>", "()V");
    jobject pipedInput = env->NewObject(pipedInputClass, inputCtor);
    jmethodID outputCtor = env->GetMethodID(
        pipedOutputClass, "<init>", "(Ljava/io/PipedInputStream;)V");
    jobject pipedOutput = env->NewObject(pipedOutputClass, outputCtor, pipedInput);
    jmethodID setIn = env->GetStaticMethodID(systemClass, "setIn", "(Ljava/io/InputStream;)V");
    env->CallStaticVoidMethod(systemClass, setIn, pipedInput);

    {
        std::lock_guard<std::mutex> lock(g_server_mutex);
        if (g_server_input) env->DeleteGlobalRef(g_server_input);
        g_server_input = env->NewGlobalRef(pipedOutput);
    }

    // Read the JAR manifest to support Vanilla's bundler and Paperclip/Purpur launchers.
    jclass fileClass = env->FindClass("java/io/File");
    jmethodID fileCtor = env->GetMethodID(fileClass, "<init>", "(Ljava/lang/String;)V");
    jobject jarFileObject = env->NewObject(fileClass, fileCtor, env->NewStringUTF(jarPath.c_str()));
    jclass jarFileClass = env->FindClass("java/util/jar/JarFile");
    jmethodID jarCtor = env->GetMethodID(jarFileClass, "<init>", "(Ljava/io/File;)V");
    jobject jarFile = env->NewObject(jarFileClass, jarCtor, jarFileObject);
    jmethodID getManifest = env->GetMethodID(
        jarFileClass, "getManifest", "()Ljava/util/jar/Manifest;");
    jobject manifest = env->CallObjectMethod(jarFile, getManifest);
    jstring mainClassName = nullptr;

    if (manifest) {
        jclass manifestClass = env->FindClass("java/util/jar/Manifest");
        jmethodID getAttributes = env->GetMethodID(
            manifestClass, "getMainAttributes", "()Ljava/util/jar/Attributes;");
        jobject attributes = env->CallObjectMethod(manifest, getAttributes);
        jclass attributesClass = env->FindClass("java/util/jar/Attributes");
        jmethodID getValue = env->GetMethodID(
            attributesClass, "getValue", "(Ljava/lang/String;)Ljava/lang/String;");
        mainClassName = static_cast<jstring>(env->CallObjectMethod(
            attributes, getValue, env->NewStringUTF("Main-Class")));
    }

    jmethodID closeJar = env->GetMethodID(jarFileClass, "close", "()V");
    env->CallVoidMethod(jarFile, closeJar);

    if (!mainClassName || env->ExceptionCheck()) {
        if (env->ExceptionCheck()) env->ExceptionClear();
        LOGE("Server JAR has no readable Main-Class manifest entry");
        if (havePreviousDirectory) chdir(previousDirectory);
        {
            std::lock_guard<std::mutex> lock(g_server_mutex);
            if (g_server_input) { env->DeleteGlobalRef(g_server_input); g_server_input = nullptr; }
        }
        g_server_running = false;
        if (attached) g_vm->DetachCurrentThread();
        return callerEnv->NewStringUTF("ERROR:SERVER_MAIN_CLASS_NOT_FOUND");
    }

    jclass fileObjectClass = env->GetObjectClass(jarFileObject);
    jmethodID toUri = env->GetMethodID(fileObjectClass, "toURI", "()Ljava/net/URI;");
    jobject uri = env->CallObjectMethod(jarFileObject, toUri);
    jclass uriClass = env->FindClass("java/net/URI");
    jmethodID toUrl = env->GetMethodID(uriClass, "toURL", "()Ljava/net/URL;");
    jobject jarUrl = env->CallObjectMethod(uri, toUrl);

    jclass urlClass = env->FindClass("java/net/URL");
    jobjectArray urls = env->NewObjectArray(1, urlClass, jarUrl);
    jclass classLoaderClass = env->FindClass("java/lang/ClassLoader");
    jmethodID getSystemClassLoader = env->GetStaticMethodID(
        classLoaderClass, "getSystemClassLoader", "()Ljava/lang/ClassLoader;");
    jobject parentLoader = env->CallStaticObjectMethod(classLoaderClass, getSystemClassLoader);
    jclass urlLoaderClass = env->FindClass("java/net/URLClassLoader");
    jmethodID newInstance = env->GetStaticMethodID(
        urlLoaderClass, "newInstance",
        "([Ljava/net/URL;Ljava/lang/ClassLoader;)Ljava/net/URLClassLoader;");
    jobject loader = env->CallStaticObjectMethod(urlLoaderClass, newInstance, urls, parentLoader);

    jmethodID loadClass = env->GetMethodID(
        classLoaderClass, "loadClass", "(Ljava/lang/String;)Ljava/lang/Class;");
    jobject serverClass = env->CallObjectMethod(loader, loadClass, mainClassName);
    jclass classClass = env->FindClass("java/lang/Class");
    jmethodID getMethod = env->GetMethodID(
        classClass, "getMethod",
        "(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;");
    jclass stringArrayClass = env->FindClass("[Ljava/lang/String;");
    jobjectArray parameterTypes = env->NewObjectArray(1, classClass, nullptr);
    env->SetObjectArrayElement(parameterTypes, 0, stringArrayClass);
    jobject mainMethod = env->CallObjectMethod(
        serverClass, getMethod, env->NewStringUTF("main"), parameterTypes);

    jclass stringClass = env->FindClass("java/lang/String");
    jobjectArray serverArgs = env->NewObjectArray(0, stringClass, nullptr);
    jobjectArray invokeArgs = env->NewObjectArray(1, env->FindClass("java/lang/Object"), nullptr);
    env->SetObjectArrayElement(invokeArgs, 0, serverArgs);
    jclass methodClass = env->FindClass("java/lang/reflect/Method");
    jmethodID invoke = env->GetMethodID(
        methodClass, "invoke",
        "(Ljava/lang/Object;[Ljava/lang/Object;)Ljava/lang/Object;");

    LOGE("Starting Minecraft server main class from %s", jarPath.c_str());
    env->CallObjectMethod(mainMethod, invoke, nullptr, invokeArgs);
    const bool failed = env->ExceptionCheck();
    if (failed) {
        env->ExceptionDescribe();
        env->ExceptionClear();
        LOGE("Minecraft server main method exited with an exception");
    }

    {
        std::lock_guard<std::mutex> lock(g_server_mutex);
        if (g_server_input) { env->DeleteGlobalRef(g_server_input); g_server_input = nullptr; }
    }
    if (havePreviousDirectory) chdir(previousDirectory);
    g_server_running = false;
    if (attached) g_vm->DetachCurrentThread();

    return callerEnv->NewStringUTF(failed ? "ERROR:SERVER_MAIN_FAILED" : "SERVER_EXITED");
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_dragonhost_agent_EmbeddedJvm_nativeSendServerCommand(
    JNIEnv* callerEnv, jobject /* thiz */, jstring commandValue) {
    if (!g_vm || !g_server_running.load())
        return callerEnv->NewStringUTF("ERROR:SERVER_NOT_RUNNING");

    std::string command = fromJava(callerEnv, commandValue);
    if (command.empty() || command.size() > 256 ||
        command.find_first_of("\r\n") != std::string::npos)
        return callerEnv->NewStringUTF("ERROR:INVALID_COMMAND");

    bool attached = false;
    JNIEnv* env = attachEmbedded(&attached);
    if (!env) return callerEnv->NewStringUTF("ERROR:EMBEDDED_VM_ATTACH_FAILED");

    std::lock_guard<std::mutex> lock(g_server_mutex);
    if (!g_server_input) {
        if (attached) g_vm->DetachCurrentThread();
        return callerEnv->NewStringUTF("ERROR:SERVER_CONSOLE_UNAVAILABLE");
    }

    jclass outputClass = env->GetObjectClass(g_server_input);
    jmethodID write = env->GetMethodID(outputClass, "write", "([B)V");
    jmethodID flush = env->GetMethodID(outputClass, "flush", "()V");
    const std::string line = command + "\n";
    jbyteArray bytes = env->NewByteArray(static_cast<jsize>(line.size()));
    env->SetByteArrayRegion(bytes, 0, static_cast<jsize>(line.size()),
                            reinterpret_cast<const jbyte*>(line.data()));
    env->CallVoidMethod(g_server_input, write, bytes);
    env->CallVoidMethod(g_server_input, flush);
    const bool failed = env->ExceptionCheck();
    if (failed) env->ExceptionClear();
    if (attached) g_vm->DetachCurrentThread();
    return callerEnv->NewStringUTF(failed ? "ERROR:COMMAND_WRITE_FAILED" : "COMMAND_SENT");
}
