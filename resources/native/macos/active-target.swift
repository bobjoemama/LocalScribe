import AppKit
import ApplicationServices
import CoreGraphics
import CryptoKit
import Darwin
import Foundation

private struct TargetPayload: Encodable {
    let platform = "darwin"
    let processId: Int32
    let applicationId: String
    let windowFingerprint: String?
    let focusedEditable: Bool?

    private enum CodingKeys: String, CodingKey {
        case platform
        case processId
        case applicationId
        case windowFingerprint
        case focusedEditable
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(platform, forKey: .platform)
        try container.encode(processId, forKey: .processId)
        try container.encode(applicationId, forKey: .applicationId)
        if let windowFingerprint {
            try container.encode(windowFingerprint, forKey: .windowFingerprint)
        } else {
            try container.encodeNil(forKey: .windowFingerprint)
        }
        if let focusedEditable {
            try container.encode(focusedEditable, forKey: .focusedEditable)
        } else {
            try container.encodeNil(forKey: .focusedEditable)
        }
    }
}

private struct ClipboardSequencePayload: Encodable {
    let sequence: Int
}

private struct ControlEventPayload: Encodable {
    let event: String
}

private struct AccessibilityPayload: Encodable {
    let accessibility: Bool
    let postEvents: Bool
}

private struct PastePayload: Encodable {
    let injected: Bool
}

private enum HelperError: Error {
    case invalidCommand
    case noFrontmostApplication
    case encodingFailed
}

private func writeJSON<T: Encodable>(_ value: T) throws {
    let encoder = JSONEncoder()
    guard var data = try? encoder.encode(value) else { throw HelperError.encodingFailed }
    data.append(0x0A)
    FileHandle.standardOutput.write(data)
}

private func attributeString(_ element: AXUIElement, _ attribute: CFString) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return nil }
    return value as? String
}

private func hashFingerprint(_ descriptor: String) -> String {
    let digest = SHA256.hash(data: Data(descriptor.utf8))
    return digest.map { String(format: "%02x", $0) }.joined()
}

private func coreGraphicsWindowFingerprint(for processId: pid_t) -> String? {
    guard let windowInfo = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements],
        kCGNullWindowID
    ) as? [[String: Any]] else {
        return nil
    }

    // CGWindowList is ordered front-to-back. For the frontmost application,
    // its first normal-layer window is a permission-free, opaque identity for
    // the window that would receive a paste. No window name leaves the helper.
    for window in windowInfo {
        guard
            let ownerPid = window[kCGWindowOwnerPID as String] as? pid_t,
            ownerPid == processId,
            let layer = window[kCGWindowLayer as String] as? Int,
            layer == 0,
            let windowNumber = window[kCGWindowNumber as String] as? CGWindowID
        else {
            continue
        }
        return hashFingerprint("\(processId)\u{0}cg-window:\(windowNumber)")
    }
    return nil
}

private func focusedWindowFingerprint(for processId: pid_t) -> String? {
    let systemWide = AXUIElementCreateSystemWide()
    var focusedApplicationValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(
        systemWide,
        kAXFocusedApplicationAttribute as CFString,
        &focusedApplicationValue
    ) == .success,
    let focusedApplicationValue,
    CFGetTypeID(focusedApplicationValue) == AXUIElementGetTypeID() else {
        return nil
    }

    let focusedApplication = unsafeBitCast(focusedApplicationValue, to: AXUIElement.self)
    var focusedPid: pid_t = 0
    guard AXUIElementGetPid(focusedApplication, &focusedPid) == .success,
          focusedPid == processId else {
        return nil
    }

    var focusedWindowValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(
        focusedApplication,
        kAXFocusedWindowAttribute as CFString,
        &focusedWindowValue
    ) == .success,
    let focusedWindowValue,
    CFGetTypeID(focusedWindowValue) == AXUIElementGetTypeID() else {
        return nil
    }

    let focusedWindow = unsafeBitCast(focusedWindowValue, to: AXUIElement.self)
    let title = attributeString(focusedWindow, kAXTitleAttribute as CFString) ?? ""
    let role = attributeString(focusedWindow, kAXRoleAttribute as CFString) ?? ""
    let subrole = attributeString(focusedWindow, kAXSubroleAttribute as CFString) ?? ""
    let descriptor = "\(processId)\u{0}\(title)\u{0}\(role)\u{0}\(subrole)"
    return hashFingerprint(descriptor)
}

private func focusedElementIsEditable(for processId: pid_t) -> Bool? {
    let systemWide = AXUIElementCreateSystemWide()
    var focusedElementValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(
        systemWide,
        kAXFocusedUIElementAttribute as CFString,
        &focusedElementValue
    ) == .success,
    let focusedElementValue,
    CFGetTypeID(focusedElementValue) == AXUIElementGetTypeID() else {
        return nil
    }

    let focusedElement = unsafeBitCast(focusedElementValue, to: AXUIElement.self)
    var focusedPid: pid_t = 0
    guard AXUIElementGetPid(focusedElement, &focusedPid) == .success,
          focusedPid == processId else {
        return nil
    }

    let subrole = attributeString(focusedElement, kAXSubroleAttribute as CFString)
    if subrole == (kAXSecureTextFieldSubrole as String) { return false }

    let role = attributeString(focusedElement, kAXRoleAttribute as CFString)
    let knownEditableRoles: Set<String> = [
        kAXTextFieldRole as String,
        kAXTextAreaRole as String,
        kAXComboBoxRole as String,
    ]
    if let role, knownEditableRoles.contains(role) { return true }

    var settable = DarwinBoolean(false)
    if AXUIElementIsAttributeSettable(
        focusedElement,
        kAXValueAttribute as CFString,
        &settable
    ) == .success {
        return settable.boolValue
    }
    return false
}

private func captureTarget() throws -> TargetPayload {
    guard let application = NSWorkspace.shared.frontmostApplication else {
        throw HelperError.noFrontmostApplication
    }
    let applicationId = application.bundleIdentifier
        ?? application.executableURL?.path
        ?? "pid:\(application.processIdentifier)"
    return TargetPayload(
        processId: application.processIdentifier,
        applicationId: applicationId,
        windowFingerprint: focusedWindowFingerprint(for: application.processIdentifier)
            ?? coreGraphicsWindowFingerprint(for: application.processIdentifier),
        focusedEditable: focusedElementIsEditable(for: application.processIdentifier)
    )
}

private func accessibilityStatus(prompt: Bool) -> AccessibilityPayload {
    if prompt {
        let options = [
            kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true
        ] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
        _ = CGRequestPostEventAccess()
    }
    return AccessibilityPayload(
        accessibility: AXIsProcessTrusted(),
        postEvents: CGPreflightPostEventAccess()
    )
}

private func pasteIntoFocusedControl() -> PastePayload {
    guard CGPreflightPostEventAccess() else {
        return PastePayload(injected: false)
    }
    let source = CGEventSource(stateID: .hidSystemState)
    guard
        let keyDown = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: true),
        let keyUp = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: false)
    else {
        return PastePayload(injected: false)
    }
    keyDown.flags = .maskCommand
    keyUp.flags = .maskCommand
    keyDown.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.012)
    keyUp.post(tap: .cghidEventTap)
    return PastePayload(injected: true)
}

private let controlKeyCodes: Set<CGKeyCode> = [59, 62]
private let spaceKeyCode: CGKeyCode = 49

private func keyIsDown(_ keyCode: CGKeyCode) -> Bool {
    CGEventSource.keyState(.combinedSessionState, key: keyCode)
}

private func anotherKeyIsDown() -> Bool {
    for rawKeyCode in 0...127 {
        let keyCode = CGKeyCode(rawKeyCode)
        if controlKeyCodes.contains(keyCode) || keyCode == spaceKeyCode { continue }
        if keyIsDown(keyCode) { return true }
    }
    return CGEventSource.buttonState(.combinedSessionState, button: .left)
        || CGEventSource.buttonState(.combinedSessionState, button: .right)
        || CGEventSource.buttonState(.combinedSessionState, button: .center)
}

private func monitorControlKey() throws -> Never {
    var controlWasDown = false
    var spaceWasDown = false
    var modifiedInputSent = false
    var iterations = 0

    while true {
        if iterations % 125 == 0 && getppid() == 1 { exit(0) }
        iterations &+= 1

        let controlIsDown = controlKeyCodes.contains(where: keyIsDown)
        let spaceIsDown = keyIsDown(spaceKeyCode)

        if controlIsDown && !controlWasDown {
            modifiedInputSent = false
            try writeJSON(ControlEventPayload(event: "control-down"))
        }

        if controlIsDown && spaceIsDown && !spaceWasDown {
            modifiedInputSent = true
            try writeJSON(ControlEventPayload(event: "space-down"))
        } else if controlIsDown && !modifiedInputSent && anotherKeyIsDown() {
            modifiedInputSent = true
            try writeJSON(ControlEventPayload(event: "modified-input"))
        }

        if !controlIsDown && controlWasDown {
            try writeJSON(ControlEventPayload(event: "control-up"))
            modifiedInputSent = false
        }

        controlWasDown = controlIsDown
        spaceWasDown = spaceIsDown
        Thread.sleep(forTimeInterval: 0.008)
    }
}

do {
    guard CommandLine.arguments.count == 2 else { throw HelperError.invalidCommand }
    switch CommandLine.arguments[1] {
    case "target":
        try writeJSON(captureTarget())
    case "clipboard-sequence":
        try writeJSON(ClipboardSequencePayload(sequence: NSPasteboard.general.changeCount))
    case "accessibility-status":
        try writeJSON(accessibilityStatus(prompt: false))
    case "request-accessibility":
        try writeJSON(accessibilityStatus(prompt: true))
    case "paste":
        try writeJSON(pasteIntoFocusedControl())
    case "control-monitor":
        try monitorControlKey()
    default:
        throw HelperError.invalidCommand
    }
} catch {
    FileHandle.standardError.write(Data("active-target helper failed\n".utf8))
    exit(2)
}
