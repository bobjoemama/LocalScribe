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
    let focusedElementFingerprint: String?

    private enum CodingKeys: String, CodingKey {
        case platform
        case processId
        case applicationId
        case windowFingerprint
        case focusedEditable
        case focusedElementFingerprint
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
        if let focusedElementFingerprint {
            try container.encode(focusedElementFingerprint, forKey: .focusedElementFingerprint)
        } else {
            try container.encodeNil(forKey: .focusedElementFingerprint)
        }
    }
}

private struct ClipboardSequencePayload: Encodable {
    let platform = "darwin"
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

private struct SelfTestPayload: Encodable {
    let platform = "darwin"
    let selfTest: Bool
}

private struct PasteExpectation {
    let processId: Int32
    let applicationId: String
    let windowFingerprint: String
    let focusedElementFingerprint: String
    let clipboardSequence: Int
}

private struct FocusedElementState {
    let editable: Bool?
    let fingerprint: String?
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

private func attributeElement(_ element: AXUIElement, _ attribute: CFString) -> AXUIElement? {
    var value: CFTypeRef?
    guard
        AXUIElementCopyAttributeValue(element, attribute, &value) == .success,
        let value,
        CFGetTypeID(value) == AXUIElementGetTypeID()
    else {
        return nil
    }
    return unsafeBitCast(value, to: AXUIElement.self)
}

private func attributeElements(_ element: AXUIElement, _ attribute: CFString) -> [AXUIElement]? {
    var value: CFTypeRef?
    guard
        AXUIElementCopyAttributeValue(element, attribute, &value) == .success,
        let values = value as? [AXUIElement]
    else {
        return nil
    }
    return values
}

private func attributePoint(_ element: AXUIElement, _ attribute: CFString) -> CGPoint? {
    var value: CFTypeRef?
    guard
        AXUIElementCopyAttributeValue(element, attribute, &value) == .success,
        let value,
        CFGetTypeID(value) == AXValueGetTypeID()
    else {
        return nil
    }
    let axValue = unsafeBitCast(value, to: AXValue.self)
    guard AXValueGetType(axValue) == .cgPoint else { return nil }
    var point = CGPoint.zero
    return AXValueGetValue(axValue, .cgPoint, &point) ? point : nil
}

private func attributeSize(_ element: AXUIElement, _ attribute: CFString) -> CGSize? {
    var value: CFTypeRef?
    guard
        AXUIElementCopyAttributeValue(element, attribute, &value) == .success,
        let value,
        CFGetTypeID(value) == AXValueGetTypeID()
    else {
        return nil
    }
    let axValue = unsafeBitCast(value, to: AXValue.self)
    guard AXValueGetType(axValue) == .cgSize else { return nil }
    var size = CGSize.zero
    return AXValueGetValue(axValue, .cgSize, &size) ? size : nil
}

private func hashFingerprint(_ descriptor: String) -> String {
    let digest = SHA256.hash(data: Data(descriptor.utf8))
    return digest.map { String(format: "%02x", $0) }.joined()
}

private func parseProcessId(_ argument: String) -> Int32? {
    let bytes = Array(argument.utf8)
    guard
        !bytes.isEmpty,
        bytes.count <= 10,
        bytes[0] >= 0x31,
        bytes[0] <= 0x39,
        bytes.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }),
        let processId = Int32(argument),
        processId > 0
    else {
        return nil
    }
    return processId
}

private func parseClipboardSequence(_ argument: String) -> Int? {
    let bytes = Array(argument.utf8)
    guard
        !bytes.isEmpty,
        bytes.count <= 16,
        bytes.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }),
        (bytes.count == 1 || bytes[0] != 0x30),
        let sequence = Int(argument),
        sequence >= 0
    else {
        return nil
    }
    return sequence
}

private func parsePasteExpectation(_ arguments: [String]) -> PasteExpectation? {
    guard
        arguments.count == 6,
        arguments[0] == "darwin",
        let processId = parseProcessId(arguments[1]),
        !arguments[2].isEmpty,
        arguments[2].utf8.count <= 1_024,
        let clipboardSequence = parseClipboardSequence(arguments[5])
    else {
        return nil
    }

    let fingerprintBytes = Array(arguments[3].utf8)
    let focusedElementFingerprintBytes = Array(arguments[4].utf8)
    guard
        fingerprintBytes.count == 64,
        fingerprintBytes.allSatisfy({
            ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66)
        }),
        focusedElementFingerprintBytes.count == 64,
        focusedElementFingerprintBytes.allSatisfy({
            ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66)
        })
    else {
        return nil
    }

    return PasteExpectation(
        processId: processId,
        applicationId: arguments[2],
        windowFingerprint: arguments[3],
        focusedElementFingerprint: arguments[4],
        clipboardSequence: clipboardSequence
    )
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
    guard
        let position = attributePoint(focusedWindow, kAXPositionAttribute as CFString),
        let size = attributeSize(focusedWindow, kAXSizeAttribute as CFString),
        let windowInfo = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[String: Any]]
    else {
        return nil
    }
    let title = attributeString(focusedWindow, kAXTitleAttribute as CFString) ?? ""
    let tolerance: CGFloat = 1
    var matchingWindowNumbers: [CGWindowID] = []
    for window in windowInfo {
        guard
            let ownerPid = window[kCGWindowOwnerPID as String] as? pid_t,
            ownerPid == processId,
            let layer = window[kCGWindowLayer as String] as? Int,
            layer == 0,
            let windowNumber = window[kCGWindowNumber as String] as? CGWindowID,
            let rawBounds = window[kCGWindowBounds as String] as? [String: Any],
            let bounds = CGRect(dictionaryRepresentation: rawBounds as CFDictionary)
        else {
            continue
        }
        if
            abs(bounds.origin.x - position.x) > tolerance
                || abs(bounds.origin.y - position.y) > tolerance
                || abs(bounds.size.width - size.width) > tolerance
                || abs(bounds.size.height - size.height) > tolerance
        {
            continue
        }
        if
            !title.isEmpty,
            let windowTitle = window[kCGWindowName as String] as? String,
            windowTitle != title
        {
            continue
        }
        matchingWindowNumbers.append(windowNumber)
    }
    // Ambiguous geometry is safer as copy-only than guessing the first window
    // of the process (two same-titled documents are a common collision).
    guard matchingWindowNumbers.count == 1, let windowNumber = matchingWindowNumbers.first else {
        return nil
    }
    return hashFingerprint("\(processId)\u{0}cg-window:\(windowNumber)")
}

private func accessibilityPathDescriptor(for element: AXUIElement) -> String? {
    var current = element
    var components: [String] = []
    for _ in 0..<32 {
        guard
            let parent = attributeElement(current, kAXParentAttribute as CFString),
            let siblings = attributeElements(parent, kAXChildrenAttribute as CFString),
            let siblingIndex = siblings.firstIndex(where: { CFEqual($0, current) })
        else {
            return nil
        }
        let role = attributeString(current, kAXRoleAttribute as CFString) ?? ""
        let subrole = attributeString(current, kAXSubroleAttribute as CFString) ?? ""
        components.append("\(siblingIndex):\(role):\(subrole)")
        if attributeString(parent, kAXRoleAttribute as CFString) == (kAXWindowRole as String) {
            return components.reversed().joined(separator: "/")
        }
        current = parent
    }
    return nil
}

private func focusedElementState(
    for processId: pid_t,
    windowFingerprint: String?
) -> FocusedElementState {
    let systemWide = AXUIElementCreateSystemWide()
    var focusedElementValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(
        systemWide,
        kAXFocusedUIElementAttribute as CFString,
        &focusedElementValue
    ) == .success,
    let focusedElementValue,
    CFGetTypeID(focusedElementValue) == AXUIElementGetTypeID() else {
        return FocusedElementState(editable: nil, fingerprint: nil)
    }

    let focusedElement = unsafeBitCast(focusedElementValue, to: AXUIElement.self)
    var focusedPid: pid_t = 0
    guard AXUIElementGetPid(focusedElement, &focusedPid) == .success,
          focusedPid == processId else {
        return FocusedElementState(editable: nil, fingerprint: nil)
    }

    let subrole = attributeString(focusedElement, kAXSubroleAttribute as CFString)
    if subrole == (kAXSecureTextFieldSubrole as String) {
        return FocusedElementState(editable: false, fingerprint: nil)
    }

    let role = attributeString(focusedElement, kAXRoleAttribute as CFString)
    let knownEditableRoles: Set<String> = [
        kAXTextFieldRole as String,
        kAXTextAreaRole as String,
        kAXComboBoxRole as String,
    ]
    var editable = false
    if let role, knownEditableRoles.contains(role) {
        editable = true
    } else {
        var settable = DarwinBoolean(false)
        if AXUIElementIsAttributeSettable(
            focusedElement,
            kAXValueAttribute as CFString,
            &settable
        ) == .success {
            editable = settable.boolValue
        }
    }

    guard
        editable,
        let windowFingerprint,
        let pathDescriptor = accessibilityPathDescriptor(for: focusedElement)
    else {
        return FocusedElementState(editable: editable, fingerprint: nil)
    }
    return FocusedElementState(
        editable: true,
        fingerprint: hashFingerprint(
            "\(processId)\u{0}\(windowFingerprint)\u{0}\(pathDescriptor)"
        )
    )
}

private func captureTarget() throws -> TargetPayload {
    guard let application = NSWorkspace.shared.frontmostApplication else {
        throw HelperError.noFrontmostApplication
    }
    let applicationId = application.bundleIdentifier
        ?? application.executableURL?.path
        ?? "pid:\(application.processIdentifier)"
    let windowFingerprint = AXIsProcessTrusted()
        ? focusedWindowFingerprint(for: application.processIdentifier)
        : coreGraphicsWindowFingerprint(for: application.processIdentifier)
    let focusedElement = focusedElementState(
        for: application.processIdentifier,
        windowFingerprint: windowFingerprint
    )
    let payload = TargetPayload(
        processId: application.processIdentifier,
        applicationId: applicationId,
        windowFingerprint: windowFingerprint,
        focusedEditable: focusedElement.editable,
        focusedElementFingerprint: focusedElement.fingerprint
    )
    guard
        let confirmedApplication = NSWorkspace.shared.frontmostApplication,
        confirmedApplication.processIdentifier == payload.processId,
        (
            confirmedApplication.bundleIdentifier
                ?? confirmedApplication.executableURL?.path
                ?? "pid:\(confirmedApplication.processIdentifier)"
        ) == payload.applicationId
    else {
        throw HelperError.noFrontmostApplication
    }
    return payload
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

private func targetMatches(_ target: TargetPayload, expectation: PasteExpectation) -> Bool {
    target.platform == "darwin"
        && target.processId == expectation.processId
        && target.applicationId == expectation.applicationId
        && target.windowFingerprint == expectation.windowFingerprint
        && target.focusedEditable == true
        && target.focusedElementFingerprint == expectation.focusedElementFingerprint
}

private func pasteIntoFocusedControl(expectation: PasteExpectation) -> PastePayload {
    guard CGPreflightPostEventAccess() else {
        return PastePayload(injected: false)
    }
    guard
        let currentTarget = try? captureTarget(),
        targetMatches(currentTarget, expectation: expectation),
        NSPasteboard.general.changeCount == expectation.clipboardSequence
    else {
        return PastePayload(injected: false)
    }

    // Focus can still change in the irreducible handoff between this native
    // recapture and the OS event post. Keep that interval free of asynchronous
    // work and fail closed on every identity or editability mismatch.
    let source = CGEventSource(stateID: .hidSystemState)
    guard
        let keyDown = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: true),
        let keyUp = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: false)
    else {
        return PastePayload(injected: false)
    }
    keyDown.flags = .maskCommand
    keyUp.flags = .maskCommand
    guard NSPasteboard.general.changeCount == expectation.clipboardSequence else {
        return PastePayload(injected: false)
    }
    keyDown.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.012)
    keyUp.post(tap: .cghidEventTap)
    return PastePayload(injected: true)
}

private func selfTest() -> Bool {
    let fingerprint = String(repeating: "a", count: 64)
    let elementFingerprint = String(repeating: "b", count: 64)
    guard
        let expectation = parsePasteExpectation([
            "darwin",
            "42",
            "com.example.Editor",
            fingerprint,
            elementFingerprint,
            "7",
        ]),
        parsePasteExpectation([
            "win32",
            "42",
            "com.example.Editor",
            fingerprint,
            elementFingerprint,
            "7",
        ]) == nil,
        parsePasteExpectation([
            "darwin",
            "042",
            "com.example.Editor",
            fingerprint,
            elementFingerprint,
            "7",
        ]) == nil,
        parsePasteExpectation([
            "darwin",
            "42",
            "com.example.Editor",
            String(repeating: "A", count: 64),
            elementFingerprint,
            "7",
        ]) == nil,
        parsePasteExpectation([
            "darwin",
            "42",
            "com.example.Editor",
            fingerprint,
            String(repeating: "A", count: 64),
            "7",
        ]) == nil,
        parsePasteExpectation([
            "darwin",
            "42",
            "com.example.Editor",
            fingerprint,
            elementFingerprint,
            "07",
        ]) == nil
    else {
        return false
    }

    let matchingTarget = TargetPayload(
        processId: 42,
        applicationId: "com.example.Editor",
        windowFingerprint: fingerprint,
        focusedEditable: true,
        focusedElementFingerprint: elementFingerprint
    )
    let nonEditableTarget = TargetPayload(
        processId: 42,
        applicationId: "com.example.Editor",
        windowFingerprint: fingerprint,
        focusedEditable: false,
        focusedElementFingerprint: elementFingerprint
    )
    let otherFocusedElement = TargetPayload(
        processId: 42,
        applicationId: "com.example.Editor",
        windowFingerprint: fingerprint,
        focusedEditable: true,
        focusedElementFingerprint: String(repeating: "c", count: 64)
    )
    return targetMatches(matchingTarget, expectation: expectation)
        && !targetMatches(nonEditableTarget, expectation: expectation)
        && !targetMatches(otherFocusedElement, expectation: expectation)
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
    guard CommandLine.arguments.count >= 2 else { throw HelperError.invalidCommand }
    switch CommandLine.arguments[1] {
    case "target":
        guard CommandLine.arguments.count == 2 else { throw HelperError.invalidCommand }
        try writeJSON(captureTarget())
    case "clipboard-sequence":
        guard CommandLine.arguments.count == 2 else { throw HelperError.invalidCommand }
        try writeJSON(ClipboardSequencePayload(sequence: NSPasteboard.general.changeCount))
    case "accessibility-status":
        guard CommandLine.arguments.count == 2 else { throw HelperError.invalidCommand }
        try writeJSON(accessibilityStatus(prompt: false))
    case "request-accessibility":
        guard CommandLine.arguments.count == 2 else { throw HelperError.invalidCommand }
        try writeJSON(accessibilityStatus(prompt: true))
    case "paste":
        guard
            CommandLine.arguments.count == 8,
            let expectation = parsePasteExpectation(Array(CommandLine.arguments[2...7]))
        else {
            throw HelperError.invalidCommand
        }
        try writeJSON(pasteIntoFocusedControl(expectation: expectation))
    case "self-test":
        guard CommandLine.arguments.count == 2, selfTest() else {
            throw HelperError.invalidCommand
        }
        try writeJSON(SelfTestPayload(selfTest: true))
    case "control-monitor":
        guard CommandLine.arguments.count == 2 else { throw HelperError.invalidCommand }
        try monitorControlKey()
    default:
        throw HelperError.invalidCommand
    }
} catch {
    FileHandle.standardError.write(Data("active-target helper failed\n".utf8))
    exit(2)
}
