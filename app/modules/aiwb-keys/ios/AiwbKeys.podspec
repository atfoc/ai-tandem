Pod::Spec.new do |s|
  s.name           = 'AiwbKeys'
  s.version        = '1.0.0'
  s.summary        = 'The hardware keyboard shortcuts of AI Whiteboard'
  s.description    = 'UIKeyCommands on the root view controller for the shortcuts the desktop has; the contract is README.md'
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
