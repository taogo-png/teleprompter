Pod::Spec.new do |s|
  s.name           = 'TeleprompterPip'
  s.version        = '1.0.0'
  s.summary        = 'Teleprompter flutuante (Picture-in-Picture)'
  s.description    = 'Desenha o roteiro rolando numa janela Picture-in-Picture do iOS.'
  s.license        = 'MIT'
  s.author         = 'Highpixel Studio'
  s.homepage       = 'https://github.com/taogo-png/teleprompter'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/taogo-png/teleprompter.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = ['AVKit', 'AVFoundation', 'CoreMedia', 'CoreVideo', 'UIKit']
  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
