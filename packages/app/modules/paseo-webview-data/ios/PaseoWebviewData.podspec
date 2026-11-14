require 'json'

Pod::Spec.new do |s|
  s.name           = 'PaseoWebviewData'
  s.version        = '0.1.0'
  s.summary        = 'Clears in-app web view data for Paseo'
  s.description    = 'Clears in-app web view data for Paseo'
  s.license        = 'Apache-2.0'
  s.author         = 'Paseo'
  s.homepage       = 'https://paseo.sh'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.4'
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'WebKit'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,swift}"
end
