Pod::Spec.new do |s|
  s.name           = 'AiwbNet'
  s.version        = '1.0.0'
  s.summary        = 'The pinned HTTP/2 connection of AI Whiteboard'
  s.description    = 'Dials, judges a certificate by its pin, and speaks HTTP/2 through the system stack; the contract is README.md'
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
