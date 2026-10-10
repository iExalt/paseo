cmake_minimum_required(VERSION 3.20)
project(paseo_sherpa_probe LANGUAGES CXX)
if(NOT MSVC OR NOT CMAKE_GENERATOR_PLATFORM STREQUAL "ARM64")
  message(FATAL_ERROR "This feasibility probe requires MSVC targeting ARM64")
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
add_library(sherpa_probe SHARED ${binding_sources})
set_target_properties(sherpa_probe PROPERTIES PREFIX "" SUFFIX ".node" OUTPUT_NAME "sherpa-onnx")
target_compile_definitions(sherpa_probe PRIVATE NAPI_CPP_EXCEPTIONS BUILDING_NODE_EXTENSION)
target_include_directories(sherpa_probe PRIVATE "${NODE_HEADERS}/include/node" "${ADDON_API}" "${SHERPA_CORE}/include")
target_link_libraries(sherpa_probe PRIVATE "${NODE_IMPORT_LIB}" "${SHERPA_CORE}/lib/sherpa-onnx-c-api.lib" "${SHERPA_CORE}/lib/onnxruntime.lib")
