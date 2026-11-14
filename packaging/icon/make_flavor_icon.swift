// Draws a build flavor's badge across the app icon: a solid band over the lower part of the
// rounded tile with the badge text (e.g. "STAGING") in bold white, so a second app on the same Mac
// is told apart at a glance in the Dock, the app switcher and Finder. Input is the committed icon
// canvas (packaging/icon/cashu-1024.png: the tile is the 824 x 824 rounded square at 100 px, corner
// radius 185, see make_icon.swift); output is a 1024 x 1024 PNG. Run by
// apps/desktop/scripts/package-macos.mjs at build time for a flavor whose iconBadge is set
// (packages/node-host/src/flavor.json); nothing it produces is committed or edited by hand.
//
//   swift packaging/icon/make_flavor_icon.swift packaging/icon/cashu-1024.png STAGING <out.png>
import AppKit

let args = CommandLine.arguments
guard args.count == 4, let base = NSImage(contentsOfFile: args[1]), !args[2].isEmpty,
      args[2].count <= 12
else {
    FileHandle.standardError.write("usage: make_flavor_icon.swift <icon.png> <BADGE> <out.png>\n".data(using: .utf8)!)
    exit(2)
}
let badge = args[2]
let size = 1024
guard let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8,
    samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
    bytesPerRow: 0, bitsPerPixel: 0)
else { exit(1) }
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
base.draw(in: NSRect(x: 0, y: 0, width: size, height: size), from: .zero, operation: .copy, fraction: 1)
// The band is clipped to the same rounded tile as the icon, so the silhouette stays the standard one.
let tile = NSRect(x: 100, y: 100, width: 824, height: 824)
NSBezierPath(roundedRect: tile, xRadius: 185, yRadius: 185).addClip()
let band = NSRect(x: 100, y: 100, width: 824, height: 230)
NSColor(calibratedRed: 0.96, green: 0.45, blue: 0.05, alpha: 1).setFill()
band.fill()
NSColor(calibratedWhite: 1, alpha: 0.9).setFill()
NSRect(x: 100, y: 330, width: 824, height: 10).fill()
let font = NSFont.systemFont(ofSize: 128, weight: .heavy)
let attributes: [NSAttributedString.Key: Any] = [
    .font: font,
    .foregroundColor: NSColor.white,
    .kern: 6,
]
let text = NSAttributedString(string: badge, attributes: attributes)
var textSize = text.size()
var drawn = text
if textSize.width > 760 {
    // Long badges shrink to fit the band.
    let scaled = NSFont.systemFont(ofSize: 128 * 760 / textSize.width, weight: .heavy)
    var smaller = attributes
    smaller[.font] = scaled
    drawn = NSAttributedString(string: badge, attributes: smaller)
    textSize = drawn.size()
}
drawn.draw(at: NSPoint(x: (CGFloat(size) - textSize.width) / 2, y: 100 + (230 - textSize.height) / 2 + 8))
NSGraphicsContext.restoreGraphicsState()
guard let png = rep.representation(using: .png, properties: [:]) else { exit(1) }
try png.write(to: URL(fileURLWithPath: args[3]))
