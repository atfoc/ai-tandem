# Writes <folder>/UITests.xcodeproj: one UI testing bundle (no app of its own: the test drives the development build that is installed
# and open, by its bundle id). The hardware keyboard's keys cannot be sent by Maestro, XCUITest can (AD-83).
# Usage: GEM_PATH=<cocoapods libexec> ruby make-project.rb <folder with the *.swift of the bundle>
require "xcodeproj"

dir = File.expand_path(ARGV.fetch(0))
proj = Xcodeproj::Project.new(File.join(dir, "UITests.xcodeproj"))
target = proj.new_target(:ui_test_bundle, "UITests", :ios, "17.0")
refs = Dir.glob(File.join(dir, "*.swift")).sort.map { |f| proj.main_group.new_file(f) }
target.add_file_references(refs)
target.build_configurations.each do |c|
  c.build_settings["PRODUCT_BUNDLE_IDENTIFIER"] = "local.aiwhiteboard.e2e.uitests"
  c.build_settings["SWIFT_VERSION"] = "5.0"
  c.build_settings["GENERATE_INFOPLIST_FILE"] = "YES"
  c.build_settings["CODE_SIGN_STYLE"] = "Automatic"
  c.build_settings["CODE_SIGNING_ALLOWED"] = "NO"
  c.build_settings["TARGETED_DEVICE_FAMILY"] = "1,2"
end
proj.save
scheme = Xcodeproj::XCScheme.new
scheme.add_test_target(target)
scheme.save_as(proj.path, "UITests", true)
