// Reads the QR code in a PNG and prints the text it holds (stdout), with CoreImage's detector (macOS): the stand-in for a phone's camera in package V4's check of
// scripts/server-code.sh: the text the app is handed by a scan is this one. Exit 1 when there is no code in the picture.
//   swift qrdecode.swift <png>
import CoreImage
import Foundation

guard CommandLine.arguments.count == 2, let image = CIImage(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])) else {
  FileHandle.standardError.write("usage: qrdecode <png>\n".data(using: .utf8)!)
  exit(2)
}
let detector = CIDetector(ofType: CIDetectorTypeQRCode, context: nil, options: [CIDetectorAccuracy: CIDetectorAccuracyHigh])!
let codes = detector.features(in: image).compactMap { ($0 as? CIQRCodeFeature)?.messageString }
guard let first = codes.first else { exit(1) }
FileHandle.standardOutput.write(first.data(using: .utf8)!)
