// Writes a Terminal.app profile (.terminal) for a theme.
// Usage: swift scripts/themes/terminal/profile.swift <id> <out.terminal>
// Colours come from src/themes/<id>/terminal/ghostty.theme (written by gen.py), so the palette
// lives in one place. The profile has no background image; the window background is semi-transparent.
// Font: DOJO_FONT (default JetBrainsMono-Regular), falling back to Menlo-Regular.
import AppKit
import Foundation

let args = CommandLine.arguments
guard args.count == 3 else {
    FileHandle.standardError.write("usage: profile.swift <id> <out.terminal>\n".data(using: .utf8)!)
    exit(2)
}
let themeId = args[1]
let outPath = args[2]

// Repository root: this file lives in scripts/themes/terminal/.
let scriptURL = URL(fileURLWithPath: #filePath)
let repo = scriptURL.deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent()
let themeDir = repo.appendingPathComponent("src/themes/\(themeId)")
let ghosttyPath = themeDir.appendingPathComponent("terminal/ghostty.theme")
let themeJsonPath = themeDir.appendingPathComponent("theme.json")

func fail(_ message: String) -> Never {
    FileHandle.standardError.write("profile.swift: \(message)\n".data(using: .utf8)!)
    exit(1)
}

// Reads key = value lines and palette = N=#hex from the Ghostty theme.
guard let ghosttyText = try? String(contentsOf: ghosttyPath, encoding: .utf8) else {
    fail("missing \(ghosttyPath.path), run gen.py first")
}
var values: [String: String] = [:]
var palette: [Int: String] = [:]
for rawLine in ghosttyText.split(separator: "\n") {
    let line = rawLine.trimmingCharacters(in: .whitespaces)
    if line.isEmpty || line.hasPrefix("#") { continue }
    guard let eq = line.firstIndex(of: "=") else { continue }
    let key = line[..<eq].trimmingCharacters(in: .whitespaces)
    let value = line[line.index(after: eq)...].trimmingCharacters(in: .whitespaces)
    if key == "palette" {
        let parts = value.split(separator: "=", maxSplits: 1).map(String.init)
        if parts.count == 2, let index = Int(parts[0]) { palette[index] = parts[1] }
    } else {
        values[key] = value
    }
}
for index in 0..<16 where palette[index] == nil { fail("palette \(index) missing") }

func color(_ hex: String, alpha: CGFloat = 1.0) -> Data {
    var h = hex
    if h.hasPrefix("#") { h.removeFirst() }
    guard h.count == 6, let v = UInt32(h, radix: 16) else { fail("bad colour \(hex)") }
    let c = NSColor(srgbRed: CGFloat((v >> 16) & 0xff) / 255,
                    green: CGFloat((v >> 8) & 0xff) / 255,
                    blue: CGFloat(v & 0xff) / 255,
                    alpha: alpha)
    return try! NSKeyedArchiver.archivedData(withRootObject: c, requiringSecureCoding: false)
}

func required(_ key: String) -> String {
    guard let value = values[key] else { fail("\(key) missing in ghostty.theme") }
    return value
}

// Profile name from theme.json (falls back to the id).
var themeName = themeId.prefix(1).uppercased() + themeId.dropFirst()
if let data = try? Data(contentsOf: themeJsonPath),
   let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
   let name = json["name"] as? String {
    themeName = name
}

// Font: JetBrains Mono when installed, otherwise Menlo.
let wanted = ProcessInfo.processInfo.environment["DOJO_FONT"] ?? "JetBrainsMono-Regular"
var font = NSFont(name: wanted, size: 18)
var fontUsed = wanted
if font == nil {
    font = NSFont(name: "Menlo-Regular", size: 18) ?? NSFont.monospacedSystemFont(ofSize: 18, weight: .regular)
    fontUsed = font!.fontName
    FileHandle.standardError.write("note: font \(wanted) not installed, using \(fontUsed)\n".data(using: .utf8)!)
}
let fontData = try! NSKeyedArchiver.archivedData(withRootObject: font!, requiringSecureCoding: false)

let background = required("background")
var profile: [String: Any] = [
    "name": "Dojo \(themeName)",
    "type": "Window Settings",
    "ProfileCurrentVersion": 2.09,
    // Semi-transparent background, same colour as the Ghostty theme.
    "BackgroundColor": color(background, alpha: 0.92),
    "TextColor": color(required("foreground")),
    "TextBoldColor": color(palette[15]!),
    "CursorColor": color(required("cursor-color")),
    "CursorTextColor": color(required("cursor-text")),
    "SelectionColor": color(required("selection-background")),
    "SelectedTextColor": color(required("selection-foreground")),
    "ANSIBlackColor": color(palette[0]!),
    "ANSIRedColor": color(palette[1]!),
    "ANSIGreenColor": color(palette[2]!),
    "ANSIYellowColor": color(palette[3]!),
    "ANSIBlueColor": color(palette[4]!),
    "ANSIMagentaColor": color(palette[5]!),
    "ANSICyanColor": color(palette[6]!),
    "ANSIWhiteColor": color(palette[7]!),
    "ANSIBrightBlackColor": color(palette[8]!),
    "ANSIBrightRedColor": color(palette[9]!),
    "ANSIBrightGreenColor": color(palette[10]!),
    "ANSIBrightYellowColor": color(palette[11]!),
    "ANSIBrightBlueColor": color(palette[12]!),
    "ANSIBrightMagentaColor": color(palette[13]!),
    "ANSIBrightCyanColor": color(palette[14]!),
    "ANSIBrightWhiteColor": color(palette[15]!),
    "Font": fontData,
    "FontAntialias": true,
    "FontWidthSpacing": 1.0,
    "FontHeightSpacing": 1.15,
    "Columns": 110,
    "Rows": 32,
    "BackgroundBlur": 0.5,
    "BackgroundBlurInactive": 0.5,
    "BackgroundAlphaInactive": 0.92,
    "BackgroundSettingsForInactiveWindows": true,
    // Cursor: 0 block, 1 underline, 2 bar.
    "CursorType": 2,
    "CursorBlink": true,
    "useOptionAsMetaKey": true,
    // Close the window on a clean shell exit (default profile value).
    "shellExitAction": 2,
]

do {
    let data = try PropertyListSerialization.data(fromPropertyList: profile, format: .xml, options: 0)
    try data.write(to: URL(fileURLWithPath: outPath))
} catch {
    fail("cannot write \(outPath): \(error)")
}
print("written \(outPath) font=\(fontUsed)")
