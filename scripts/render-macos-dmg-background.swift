// Regenerate with: swift scripts/render-macos-dmg-background.swift assets/installer
// Offscreen AppKit drawing only; no application/Finder UI automation.
import AppKit

guard CommandLine.arguments.count == 2 else { fatalError("output directory required") }
let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
for scale in [1, 2] {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 640 * scale, pixelsHigh: 400 * scale,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    NSGraphicsContext.current!.cgContext.scaleBy(x: CGFloat(scale), y: CGFloat(scale))
    NSColor(calibratedRed: 0.96, green: 0.98, blue: 0.97, alpha: 1).setFill()
    NSRect(x: 0, y: 0, width: 640, height: 400).fill()
    func text(_ value: String, y: CGFloat, size: CGFloat, weight: NSFont.Weight, color: NSColor) {
        let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: size, weight: weight), .foregroundColor: color]
        let string = value as NSString
        string.draw(at: NSPoint(x: (640 - string.size(withAttributes: attributes).width) / 2, y: y), withAttributes: attributes)
    }
    text("Install Oh Agent", y: 315, size: 27, weight: .semibold, color: NSColor(calibratedRed: 0.10, green: 0.19, blue: 0.17, alpha: 1))
    text("Your agent world, on your Mac.", y: 284, size: 15, weight: .regular, color: NSColor(calibratedWhite: 0.32, alpha: 1))
    let arrow = NSBezierPath()
    arrow.move(to: NSPoint(x: 286, y: 200)); arrow.line(to: NSPoint(x: 350, y: 200))
    arrow.move(to: NSPoint(x: 335, y: 215)); arrow.line(to: NSPoint(x: 350, y: 200)); arrow.line(to: NSPoint(x: 335, y: 185))
    arrow.lineWidth = 4; arrow.lineCapStyle = .round; arrow.lineJoinStyle = .round
    NSColor(calibratedRed: 0.10, green: 0.48, blue: 0.38, alpha: 1).setStroke(); arrow.stroke()
    text("Drag Oh Agent to Applications to install.", y: 67, size: 16, weight: .medium, color: NSColor(calibratedWhite: 0.22, alpha: 1))
    text("Then open Oh Agent from Applications.", y: 42, size: 13, weight: .regular, color: NSColor(calibratedWhite: 0.35, alpha: 1))
    NSGraphicsContext.restoreGraphicsState()
    let name = scale == 1 ? "macos-background.png" : "macos-background@2x.png"
    try bitmap.representation(using: .png, properties: [:])!.write(to: directory.appendingPathComponent(name))
}
