require 'json'

Pod::Spec.new do |s|
  s.name           = 'PaseoHardwareKeyboard'
  s.version        = '0.1.0'
  s.summary        = 'Hardware keyboard shortcuts for Paseo'
  s.description    = 'Hardware keyboard shortcuts for Paseo'
  s.license        = 'Apache-2.0'
  s.author         = 'Paseo'
  s.homepage       = 'https://paseo.sh'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.4'
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'GameController'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,swift}"
end
