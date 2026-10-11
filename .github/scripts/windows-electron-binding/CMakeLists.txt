cmake_minimum_required(VERSION 3.20)
project(paseo_sherpa_electron LANGUAGES CXX)
if(NOT MSVC OR NOT CMAKE_GENERATOR_PLATFORM STREQUAL "ARM64")
  message(FATAL_ERROR "The missing Windows binding must be built natively for ARM64")
endif()
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_MSVC_RUNTIME_LIBRARY MultiThreadedDLL)
set(binding_sources
  audio-tagging keyword-spotting non-streaming-asr non-streaming-speaker-diarization
  non-streaming-speech-denoiser non-streaming-tts offline-punctuation online-punctuation
  streaming-speech-denoiser sherpa-onnx-node-addon-api speaker-identification
  spoken-language-identification streaming-asr vad version wave-reader wave-writer resampler)
list(TRANSFORM binding_sources PREPEND "${BINDING_SOURCE}/")
list(TRANSFORM binding_sources APPEND ".cc")
add_library(sherpa_electron SHARED ${binding_sources} "${DELAY_LOAD_HOOK}")
set_target_properties(sherpa_electron PROPERTIES PREFIX "" SUFFIX ".node" OUTPUT_NAME "sherpa-onnx")
target_compile_definitions(sherpa_electron PRIVATE NAPI_CPP_EXCEPTIONS BUILDING_NODE_EXTENSION HOST_BINARY="node.exe")
target_include_directories(sherpa_electron PRIVATE "${ELECTRON_HEADERS}/include/node" "${ADDON_API}" "${SHERPA_CORE}/include")
# Electron exports Node symbols from its renamed executable. The hook must be
# linked directly into this addon; a normal node.exe import cannot load it.
# https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules
target_link_libraries(sherpa_electron PRIVATE "${ELECTRON_IMPORT_LIB}" delayimp "${SHERPA_CORE}/lib/sherpa-onnx-c-api.lib" "${SHERPA_CORE}/lib/onnxruntime.lib")
target_link_options(sherpa_electron PRIVATE "/DELAYLOAD:node.exe")
