import CoreGraphics
import Foundation

let durationMilliseconds = CommandLine.arguments.dropFirst().first.flatMap(Int.init) ?? 1_000
let controlKeyCode: CGKeyCode = 59

guard
    let source = CGEventSource(stateID: .privateState),
    let keyDown = CGEvent(keyboardEventSource: source, virtualKey: controlKeyCode, keyDown: true),
    let keyUp = CGEvent(keyboardEventSource: source, virtualKey: controlKeyCode, keyDown: false)
else {
    FileHandle.standardError.write(Data("Could not create synthetic Control events\n".utf8))
    exit(2)
}

keyDown.post(tap: .cghidEventTap)
Thread.sleep(forTimeInterval: Double(durationMilliseconds) / 1_000)
keyUp.post(tap: .cghidEventTap)
