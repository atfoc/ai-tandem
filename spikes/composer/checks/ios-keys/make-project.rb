# Writes KeysUITests.xcodeproj: one UI testing bundle (no app of its own: the test drives the spike's installed
# development build by its bundle id). The hardware keyboard's keys cannot be sent by Maestro, XCUITest can.
# Usage: GEM_PATH=<cocoapods libexec> ruby make-project.rb <folder with KeysTests.swift>
require "xcodeproj"

dir = File.expand_path(ARGV.fetch(0))
proj = Xcodeproj::Project.new(File.join(dir, "KeysUITests.xcodeproj"))
target = proj.new_target(:ui_test_bundle, "KeysUITests", :ios, "17.0")
ref = proj.main_group.new_file(File.join(dir, "KeysTests.swift"))
target.add_file_references([ref])
target.build_configurations.each do |c|
  c.build_settings["PRODUCT_BUNDLE_IDENTIFIER"] = "dev.aiwhiteboard.spike.composer.keystests"
  c.build_settings["SWIFT_VERSION"] = "5.0"
  c.build_settings["GENERATE_INFOPLIST_FILE"] = "YES"
  c.build_settings["CODE_SIGN_STYLE"] = "Automatic"
  c.build_settings["CODE_SIGNING_ALLOWED"] = "NO"
  c.build_settings["TARGETED_DEVICE_FAMILY"] = "1,2"
end
proj.save
scheme = Xcodeproj::XCScheme.new
scheme.add_test_target(target)
scheme.save_as(proj.path, "KeysUITests", true)
