cmake_minimum_required(VERSION 3.22.1)
project(dragonhost_jvm LANGUAGES CXX)

add_library(dragonhost_jvm SHARED embedded_jvm.cpp)
target_compile_features(dragonhost_jvm PRIVATE cxx_std_17)
target_compile_options(dragonhost_jvm PRIVATE -Wall -Wextra -Werror)
target_link_libraries(dragonhost_jvm PRIVATE dl log)
