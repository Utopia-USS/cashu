// Turns a square logo into a macOS app icon canvas (1024 x 1024 PNG): the logo inside the
// standard rounded square (824 x 824 at 100 px, corner radius 185) with a soft drop shadow,
// transparent around it. One-off tool; the result is committed as cashu-1024.png (the desktop app's
// window and dock icon) and, converted once, as cashU.icns (the electron-builder app icon):
//
//   swift packaging/icon/make_icon.swift <square logo (png/webp/...)> packaging/icon/cashu-1024.png
//   mkdir cashU.iconset && for s in 16 32 128 256 512; do
//     sips -z $s $s packaging/icon/cashu-1024.png --out cashU.iconset/icon_${s}x${s}.png
//     sips -z $((s*2)) $((s*2)) packaging/icon/cashu-1024.png --out cashU.iconset/icon_${s}x${s}@2x.png
//   done && iconutil -c icns cashU.iconset -o packaging/icon/cashU.icns
import AppKit

let args = CommandLine.arguments
guard args.count == 3, let logo = NSImage(contentsOfFile: args[1]) else {
    FileHandle.standardError.write("usage: make_icon.swift <square logo> <out.png>\n".data(using: .utf8)!)
    exit(2)
}
let size = 1024
guard let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8,
    samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
    bytesPerRow: 0, bitsPerPixel: 0)
else { exit(1) }
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
let tile = NSRect(x: 100, y: 100, width: 824, height: 824)
let shape = NSBezierPath(roundedRect: tile, xRadius: 185, yRadius: 185)
let shadow = NSShadow()
shadow.shadowOffset = NSSize(width: 0, height: -10)
shadow.shadowBlurRadius = 24
shadow.shadowColor = NSColor.black.withAlphaComponent(0.3)
NSGraphicsContext.saveGraphicsState()
shadow.set()
NSColor(calibratedWhite: 0.05, alpha: 1).setFill()
shape.fill()
NSGraphicsContext.restoreGraphicsState()
shape.addClip()
logo.draw(in: tile, from: .zero, operation: .sourceOver, fraction: 1)
NSGraphicsContext.restoreGraphicsState()
guard let png = rep.representation(using: .png, properties: [:]) else { exit(1) }
try png.write(to: URL(fileURLWithPath: args[2]))
