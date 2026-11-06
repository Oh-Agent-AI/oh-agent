// Native bookmarks survive remounting the image, including on macOS 26.
import Foundation

do {
    guard CommandLine.arguments.count == 3 else { throw NSError(domain: "DMGBookmark", code: 1) }
    let file = URL(fileURLWithPath: CommandLine.arguments[2])
    switch CommandLine.arguments[1] {
    case "create":
        let data = try file.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
        FileHandle.standardOutput.write(data)
    case "resolve":
        var stale = false
        let url = try URL(resolvingBookmarkData: Data(contentsOf: file), options: [.withoutUI, .withoutMounting], relativeTo: nil, bookmarkDataIsStale: &stale)
        guard FileManager.default.fileExists(atPath: url.path) else { throw NSError(domain: "DMGBookmark", code: 2) }
        print(url.path)
    default: throw NSError(domain: "DMGBookmark", code: 3)
    }
} catch {
    fputs("DMG background bookmark failed: \(error)\n", stderr)
    exit(1)
}
