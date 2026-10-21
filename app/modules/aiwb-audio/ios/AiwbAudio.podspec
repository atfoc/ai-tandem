Pod::Spec.new do |s|
  s.name           = 'AiwbAudio'
  s.version        = '1.0.0'
  s.summary        = 'The microphone, the audio session and the PCM player of the voice chats of AI Whiteboard'
  s.description    = 'One AVAudioEngine with voice processing for capture and a player node for playback; the contract is README.md'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4',
    :tvos => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
