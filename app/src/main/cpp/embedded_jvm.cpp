#include <jni.h>
#include <dlfcn.h>
#include <android/log.h>
#include <cstdlib>
#include <mutex>
#include <string>

#define LOG_TAG "DragonHostJVM"
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace {
std::mutex g_mutex;
JavaVM* g_vm = nullptr;
void* g_jvm_handle = nullptr;

using CreateJavaVm = jint (JNICALL *)(JavaVM**, void**, void*);

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
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_dragonhost_agent_EmbeddedJvm_nativeStart(
    JNIEnv* env, jobject /* thiz */, jstring runtimeRootValue,
    jstring tempDirValue, jstring homeDirValue) {
    std::lock_guard<std::mutex> lock(g_mutex);
    if (g_vm) {
        return env->NewStringUTF("ALREADY_RUNNING");
    }

    const char* runtimeChars = env->GetStringUTFChars(runtimeRootValue, nullptr);
    const char* tempChars = env->GetStringUTFChars(tempDirValue, nullptr);
    const char* homeChars = env->GetStringUTFChars(homeDirValue, nullptr);
    if (!runtimeChars || !tempChars || !homeChars) {
        if (runtimeChars) env->ReleaseStringUTFChars(runtimeRootValue, runtimeChars);
        if (tempChars) env->ReleaseStringUTFChars(tempDirValue, tempChars);
        if (homeChars) env->ReleaseStringUTFChars(homeDirValue, homeChars);
        return env->NewStringUTF("ERROR:INVALID_PATH_ARGUMENT");
    }

    const std::string runtimeRoot(runtimeChars);
    const std::string tempDir(tempChars);
    const std::string homeDir(homeChars);
    env->ReleaseStringUTFChars(runtimeRootValue, runtimeChars);
    env->ReleaseStringUTFChars(tempDirValue, tempChars);
    env->ReleaseStringUTFChars(homeDirValue, homeChars);

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

    const std::string version = readJavaVersion(vmEnv);
    return env->NewStringUTF(("JVM_STARTED:" + version).c_str());
}
