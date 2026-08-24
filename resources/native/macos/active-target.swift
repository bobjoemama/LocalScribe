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
    let reason: String?

    init(injected: Bool, reason: String? = nil) {
        self.injected = injected
        self.reason = reason
    }
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

private func attributeBool(_ element: AXUIElement, _ attribute: CFString) -> Bool? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return nil }
    return value as? Bool
}

private func attributeIsSettable(_ element: AXUIElement, _ attribute: CFString) -> Bool {
    var settable = DarwinBoolean(false)
    return AXUIElementIsAttributeSettable(element, attribute, &settable) == .success
        && settable.boolValue
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

private func unambiguousWindowNumber(_ windowNumbers: [CGWindowID]) -> CGWindowID? {
    windowNumbers.count == 1 ? windowNumbers[0] : nil
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

    var windowNumbers: [CGWindowID] = []
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
        windowNumbers.append(windowNumber)
    }
    // Without Accessibility geometry, only one normal-layer window is
    // unambiguous. Never guess the frontmost member of a multi-window app.
    guard let windowNumber = unambiguousWindowNumber(windowNumbers) else {
        return nil
    }
    return hashFingerprint("\(processId)\u{0}cg-window:\(windowNumber)")
}

private func focusedWindowFingerprint(
    for processId: pid_t,
    focusedApplication: AXUIElement,
    focusedElement: AXUIElement?
) -> String? {
    /*
     * Query the already-confirmed frontmost process directly. On newer macOS
     * builds the system-wide element can report a trusted process while still
     * declining kAXFocusedApplicationAttribute and
     * kAXFocusedUIElementAttribute. AXUIElementCreateApplication does not
     * weaken the identity boundary: captureTarget confirms the frontmost PID
     * immediately before and after these reads.
     */
    guard let focusedWindow = (
        attributeElement(focusedApplication, kAXFocusedWindowAttribute as CFString)
            ?? attributeElement(focusedApplication, kAXMainWindowAttribute as CFString)
            ?? focusedElement.flatMap {
                attributeElement($0, kAXWindowAttribute as CFString)
            }
    ) else { return coreGraphicsWindowFingerprint(for: processId) }
    guard
        let position = attributePoint(focusedWindow, kAXPositionAttribute as CFString),
        let size = attributeSize(focusedWindow, kAXSizeAttribute as CFString),
        let windowInfo = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[String: Any]]
    else { return coreGraphicsWindowFingerprint(for: processId) }
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
        matchingWindowNumbers.append(windowNumber)
    }
    if let windowNumber = unambiguousWindowNumber(matchingWindowNumbers) {
        return hashFingerprint("\(processId)\u{0}cg-window:\(windowNumber)")
    }
    // Some current macOS applications expose the focused control but omit or
    // distort the window geometry. A single normal-layer process window is
    // still an exact identity; multiple windows remain copy-only.
    return coreGraphicsWindowFingerprint(for: processId)
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

private func boundedAccessibilityIdentifier(_ element: AXUIElement) -> String? {
    guard let identifier = attributeString(element, kAXIdentifierAttribute as CFString) else {
        return nil
    }
    let trimmed = identifier.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, trimmed.utf8.count <= 1_024 else { return nil }
    return trimmed
}

private func finiteGeometryComponent(_ value: CGFloat) -> String? {
    guard value.isFinite else { return nil }
    // Accessibility geometry can move by sub-pixel rounding between adjacent
    // reads. Half-point quantization keeps the identity stable without making
    // distinct controls at normal UI spacing collide.
    return String(Int((value * 2).rounded()))
}

private func accessibilityGeometryDescriptor(for element: AXUIElement) -> String? {
    guard
        let position = attributePoint(element, kAXPositionAttribute as CFString),
        let size = attributeSize(element, kAXSizeAttribute as CFString),
        size.width >= 0,
        size.height >= 0
    else { return nil }

    var relativePosition = position
    if
        let window = attributeElement(element, kAXWindowAttribute as CFString),
        let windowPosition = attributePoint(window, kAXPositionAttribute as CFString)
    {
        relativePosition.x -= windowPosition.x
        relativePosition.y -= windowPosition.y
    }
    guard
        let x = finiteGeometryComponent(relativePosition.x),
        let y = finiteGeometryComponent(relativePosition.y),
        let width = finiteGeometryComponent(size.width),
        let height = finiteGeometryComponent(size.height)
    else { return nil }
    let role = attributeString(element, kAXRoleAttribute as CFString) ?? ""
    let subrole = attributeString(element, kAXSubroleAttribute as CFString) ?? ""
    return "geometry:\(role):\(subrole):\(x):\(y):\(width):\(height)"
}

private func layeredElementIdentityDescriptor(
    identifier: String?,
    role: String,
    subrole: String,
    geometry: () -> String?,
    ancestry: () -> String?
) -> String? {
    if let identifier {
        return "identifier:\(role):\(subrole):\(identifier)"
    }
    if let geometry = geometry() {
        return geometry
    }
    if let ancestry = ancestry() {
        return "ancestry:\(ancestry)"
    }
    return nil
}

private func focusedElementIdentityDescriptor(_ element: AXUIElement) -> String? {
    let role = attributeString(element, kAXRoleAttribute as CFString) ?? ""
    let subrole = attributeString(element, kAXSubroleAttribute as CFString) ?? ""
    return layeredElementIdentityDescriptor(
        identifier: boundedAccessibilityIdentifier(element),
        role: role,
        subrole: subrole,
        geometry: { accessibilityGeometryDescriptor(for: element) },
        ancestry: { accessibilityPathDescriptor(for: element) }
    )
}

private func editabilityFromCapabilities(
    role: String?,
    subrole: String?,
    enabled: Bool?,
    valueSettable: Bool,
    selectedTextSettable: Bool,
    selectedTextRangeSettable: Bool
) -> Bool {
    if subrole == (kAXSecureTextFieldSubrole as String) { return false }
    if enabled == false { return false }

    let knownStaticRoles: Set<String> = [
        kAXStaticTextRole as String,
        kAXButtonRole as String,
        kAXCheckBoxRole as String,
        kAXRadioButtonRole as String,
        kAXImageRole as String,
        "AXLink",
    ]
    if let role, knownStaticRoles.contains(role) { return false }

    // A role is descriptive, not proof that the current control accepts
    // mutation. Read-only text controls can retain both their text role and a
    // settable selection range, so range movement alone is not enough. The T3
    // Chromium contenteditable observed on macOS exposes AXTextField with a
    // settable AXValue and settable selection range, but not settable
    // AXSelectedText. Other native editors may expose selected-text mutation.
    // Querying settable flags never reads either value or selected content.
    let valueMutableTextRoles: Set<String> = [
        kAXTextFieldRole as String,
        kAXTextAreaRole as String,
        kAXComboBoxRole as String,
    ]
    let textRoleHasMutableValue = role.map(valueMutableTextRoles.contains) == true
        && valueSettable
    // Use range mutability only as explicit negative evidence: it cannot turn
    // a control editable by itself.
    if selectedTextRangeSettable && !textRoleHasMutableValue && !selectedTextSettable {
        return false
    }
    return textRoleHasMutableValue || selectedTextSettable
}

private func focusedElementIsEditable(_ element: AXUIElement) -> Bool {
    // Chromium and Electron contenteditable surfaces commonly expose a web
    // role rather than AXTextArea. Positive value or selected-text mutability
    // is required; selection/range support alone also exists on read-only
    // controls. Static, disabled, and secure controls are rejected first.
    return editabilityFromCapabilities(
        role: attributeString(element, kAXRoleAttribute as CFString),
        subrole: attributeString(element, kAXSubroleAttribute as CFString),
        enabled: attributeBool(element, kAXEnabledAttribute as CFString),
        valueSettable: attributeIsSettable(
            element,
            kAXValueAttribute as CFString
        ),
        selectedTextSettable: attributeIsSettable(
            element,
            kAXSelectedTextAttribute as CFString
        ),
        selectedTextRangeSettable: attributeIsSettable(
            element,
            kAXSelectedTextRangeAttribute as CFString
        )
    )
}

private let manualAccessibilityAttribute = "AXManualAccessibility" as CFString
private let editableAncestorAttribute = "AXEditableAncestor" as CFString
private let focusedElementLookupAttemptCount = 6
private let focusedElementLookupInterval: TimeInterval = 0.02

private func firstAvailable<T>(
    attemptCount: Int,
    lookup: () -> T?,
    wait: () -> Void
) -> T? {
    guard attemptCount > 0 else { return nil }
    for attempt in 0..<attemptCount {
        if let value = lookup() { return value }
        if attempt + 1 < attemptCount { wait() }
    }
    return nil
}

private func copyFocusedUIElement(_ application: AXUIElement) -> AXUIElement? {
    attributeElement(application, kAXFocusedUIElementAttribute as CFString)
}

private func manualAccessibilityActivationNeeded(
    role: String?,
    valueSettable: Bool,
    selectedTextSettable: Bool,
    editableAncestorAvailable: Bool
) -> Bool {
    role == "AXWebArea"
        && !valueSettable
        && !selectedTextSettable
        && !editableAncestorAvailable
}

private func manualAccessibilityActivationNeeded(_ element: AXUIElement) -> Bool {
    manualAccessibilityActivationNeeded(
        role: attributeString(element, kAXRoleAttribute as CFString),
        valueSettable: attributeIsSettable(element, kAXValueAttribute as CFString),
        selectedTextSettable: attributeIsSettable(
            element,
            kAXSelectedTextAttribute as CFString
        ),
        editableAncestorAvailable: attributeElement(
            element,
            editableAncestorAttribute
        ) != nil
    )
}

private func focusedUIElementEnablingManualAccessibilityIfNeeded(
    _ application: AXUIElement
) -> AXUIElement? {
    let initialFocusedElement = copyFocusedUIElement(application)
    if let initialFocusedElement,
       !manualAccessibilityActivationNeeded(initialFocusedElement) {
        return initialFocusedElement
    }

    // Electron documents AXManualAccessibility as the third-party integration
    // point for enabling Chromium's otherwise lazy accessibility tree. A lazy
    // tree can return a non-null AXWebArea placeholder with no mutation
    // capability or editable ancestor, so existence alone cannot skip
    // activation. Toggle only the documented attribute when focus is missing
    // or has that exact placeholder shape and the app declares it settable.
    // Chromium updates asynchronously; retry for at most 100 ms and fail closed.
    guard
        attributeIsSettable(application, manualAccessibilityAttribute),
        AXUIElementSetAttributeValue(
            application,
            manualAccessibilityAttribute,
            kCFBooleanTrue
        ) == .success
    else { return nil }

    return firstAvailable(
        attemptCount: focusedElementLookupAttemptCount,
        lookup: {
            guard let candidate = copyFocusedUIElement(application),
                  !manualAccessibilityActivationNeeded(candidate) else {
                return nil
            }
            return candidate
        },
        wait: { Thread.sleep(forTimeInterval: focusedElementLookupInterval) }
    )
}

private func elementIsInParentChain(
    _ candidate: AXUIElement,
    of descendant: AXUIElement
) -> Bool {
    var current = descendant
    for _ in 0..<32 {
        if CFEqual(candidate, current) { return true }
        guard let parent = attributeElement(current, kAXParentAttribute as CFString),
              !CFEqual(parent, current) else {
            return false
        }
        current = parent
    }
    return false
}

private func elementsShareAccessibilityWindow(
    _ first: AXUIElement,
    _ second: AXUIElement
) -> Bool {
    guard
        let firstWindow = attributeElement(first, kAXWindowAttribute as CFString),
        let secondWindow = attributeElement(second, kAXWindowAttribute as CFString)
    else { return false }
    return CFEqual(firstWindow, secondWindow)
}

private func editableAncestorRelationshipIsAllowed(
    candidateDiffers: Bool,
    sameProcess: Bool,
    inParentChain: Bool,
    sameWindow: Bool,
    candidateEditable: Bool
) -> Bool {
    candidateDiffers && sameProcess && inParentChain && sameWindow && candidateEditable
}

private func focusedEditableElement(
    _ focusedElement: AXUIElement,
    processId: pid_t
) -> AXUIElement? {
    if focusedElementIsEditable(focusedElement) { return focusedElement }

    // Chromium can focus a static descendant (for example a text node inside
    // a Lexical contenteditable) instead of the editor root. Resolve only its
    // nearest declared editable ancestor, then prove the relationship, process,
    // window, and actual write capability before using that stable editor root.
    guard let editableAncestor = attributeElement(
        focusedElement,
        editableAncestorAttribute
    ) else { return nil }

    var ancestorPid: pid_t = 0
    guard
        AXUIElementGetPid(editableAncestor, &ancestorPid) == .success,
        editableAncestorRelationshipIsAllowed(
            candidateDiffers: !CFEqual(editableAncestor, focusedElement),
            sameProcess: ancestorPid == processId,
            inParentChain: elementIsInParentChain(editableAncestor, of: focusedElement),
            sameWindow: elementsShareAccessibilityWindow(editableAncestor, focusedElement),
            candidateEditable: focusedElementIsEditable(editableAncestor)
        )
    else { return nil }
    return editableAncestor
}

private func focusedElementState(
    for processId: pid_t,
    focusedElement: AXUIElement?,
    windowFingerprint: String?
) -> FocusedElementState {
    guard let focusedElement else {
        return FocusedElementState(editable: nil, fingerprint: nil)
    }
    var focusedPid: pid_t = 0
    guard AXUIElementGetPid(focusedElement, &focusedPid) == .success,
          focusedPid == processId else {
        return FocusedElementState(editable: nil, fingerprint: nil)
    }

    let editableElement = focusedEditableElement(focusedElement, processId: processId)
    let editable = editableElement != nil

    guard
        let editableElement,
        let windowFingerprint,
        let identityDescriptor = focusedElementIdentityDescriptor(editableElement)
    else {
        return FocusedElementState(editable: editable, fingerprint: nil)
    }
    return FocusedElementState(
        editable: true,
        fingerprint: hashFingerprint(
            "\(processId)\u{0}\(windowFingerprint)\u{0}\(identityDescriptor)"
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
    let accessibilityTrusted = AXIsProcessTrusted()
    let focusedApplication = AXUIElementCreateApplication(application.processIdentifier)
    // Chromium may not expose either its focused control or focused window
    // until AXManualAccessibility activates the tree. Capture/activate focus
    // first, then derive the window from the now-current tree. The inverse
    // order degraded a multi-window Electron target to copy-only on its first
    // dictation even though the exact window became available milliseconds
    // later.
    let focusedUIElement = accessibilityTrusted
        ? focusedUIElementEnablingManualAccessibilityIfNeeded(focusedApplication)
        : nil
    let windowFingerprint = accessibilityTrusted
        ? focusedWindowFingerprint(
            for: application.processIdentifier,
            focusedApplication: focusedApplication,
            focusedElement: focusedUIElement
        )
        : coreGraphicsWindowFingerprint(for: application.processIdentifier)
    let focusedElement = focusedElementState(
        for: application.processIdentifier,
        focusedElement: focusedUIElement,
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
        return PastePayload(injected: false, reason: "permission_denied")
    }
    guard let currentTarget = try? captureTarget() else {
        return PastePayload(injected: false, reason: "target_unavailable")
    }
    guard targetMatches(currentTarget, expectation: expectation) else {
        return PastePayload(injected: false, reason: "target_changed")
    }
    guard NSPasteboard.general.changeCount == expectation.clipboardSequence else {
        return PastePayload(injected: false, reason: "clipboard_changed")
    }

    let source = CGEventSource(stateID: .hidSystemState)
    guard
        let keyDown = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: true),
        let keyUp = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: false)
    else {
        return PastePayload(injected: false, reason: "event_unavailable")
    }
    keyDown.flags = .maskCommand
    keyUp.flags = .maskCommand
    // Event construction is small but fallible work. Recheck the complete app,
    // window, editable-control, and control-fingerprint boundary once more
    // after it, immediately before the clipboard check and post.
    guard let finalTarget = try? captureTarget(),
          targetMatches(finalTarget, expectation: expectation) else {
        return PastePayload(injected: false, reason: "target_changed")
    }
    guard NSPasteboard.general.changeCount == expectation.clipboardSequence else {
        return PastePayload(injected: false, reason: "clipboard_changed")
    }
    // CGEvent offers no compare-and-post transaction with Accessibility or the
    // pasteboard. Focus or clipboard contents can still change after these
    // final observations and before macOS consumes Command-V. Keep the residual
    // interval synchronous and minimal, retain dictated text on the clipboard,
    // and describe automatic paste as best-effort rather than atomic targeting.
    keyDown.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.012)
    keyUp.post(tap: .cghidEventTap)
    return PastePayload(injected: true)
}

private func selfTest() -> Bool {
    let fingerprint = String(repeating: "a", count: 64)
    let elementFingerprint = String(repeating: "b", count: 64)
    let identifierIdentity = layeredElementIdentityDescriptor(
        identifier: "editor-id",
        role: "AXWebArea",
        subrole: "",
        geometry: { "geometry:unused" },
        ancestry: { "ancestry-unused" }
    )
    let geometryIdentity = layeredElementIdentityDescriptor(
        identifier: nil,
        role: "AXWebArea",
        subrole: "",
        geometry: { "geometry:AXWebArea::10:20:30:40" },
        ancestry: { "ancestry-unused" }
    )
    let ancestryIdentity = layeredElementIdentityDescriptor(
        identifier: nil,
        role: "AXWebArea",
        subrole: "",
        geometry: { nil },
        ancestry: { "0:AXWebArea:" }
    )
    var immediateLookups = 0
    var immediateWaits = 0
    let immediateValue: Int? = firstAvailable(
        attemptCount: 3,
        lookup: {
            immediateLookups += 1
            return 1
        },
        wait: { immediateWaits += 1 }
    )
    var delayedLookups = 0
    var delayedWaits = 0
    let delayedValue: Int? = firstAvailable(
        attemptCount: 3,
        lookup: {
            delayedLookups += 1
            return delayedLookups == 3 ? 7 : nil
        },
        wait: { delayedWaits += 1 }
    )
    var exhaustedLookups = 0
    var exhaustedWaits = 0
    let exhaustedValue: Int? = firstAvailable(
        attemptCount: 3,
        lookup: {
            exhaustedLookups += 1
            return nil
        },
        wait: { exhaustedWaits += 1 }
    )
    guard
        unambiguousWindowNumber([7]) == 7,
        unambiguousWindowNumber([]) == nil,
        unambiguousWindowNumber([7, 8]) == nil,
        identifierIdentity == "identifier:AXWebArea::editor-id",
        geometryIdentity == "geometry:AXWebArea::10:20:30:40",
        ancestryIdentity == "ancestry:0:AXWebArea:",
        editabilityFromCapabilities(
            role: "AXWebArea",
            subrole: nil,
            enabled: true,
            valueSettable: false,
            selectedTextSettable: true,
            selectedTextRangeSettable: true
        ),
        // Exact metadata-only shape observed for the focused T3 Chromium
        // composer after its accessibility tree is active.
        editabilityFromCapabilities(
            role: kAXTextFieldRole as String,
            subrole: nil,
            enabled: true,
            valueSettable: true,
            selectedTextSettable: false,
            selectedTextRangeSettable: true
        ),
        // A read-only text control can still move its selection. That is not a
        // positive mutation capability and must never authorize automatic paste.
        !editabilityFromCapabilities(
            role: kAXTextFieldRole as String,
            subrole: nil,
            enabled: true,
            valueSettable: false,
            selectedTextSettable: false,
            selectedTextRangeSettable: true
        ),
        !editabilityFromCapabilities(
            role: kAXTextAreaRole as String,
            subrole: nil,
            enabled: true,
            valueSettable: false,
            selectedTextSettable: false,
            selectedTextRangeSettable: false
        ),
        !editabilityFromCapabilities(
            role: "AXSlider",
            subrole: nil,
            enabled: true,
            valueSettable: true,
            selectedTextSettable: false,
            selectedTextRangeSettable: false
        ),
        manualAccessibilityActivationNeeded(
            role: "AXWebArea",
            valueSettable: false,
            selectedTextSettable: false,
            editableAncestorAvailable: false
        ),
        !manualAccessibilityActivationNeeded(
            role: "AXWebArea",
            valueSettable: true,
            selectedTextSettable: false,
            editableAncestorAvailable: false
        ),
        !manualAccessibilityActivationNeeded(
            role: "AXWebArea",
            valueSettable: false,
            selectedTextSettable: false,
            editableAncestorAvailable: true
        ),
        !manualAccessibilityActivationNeeded(
            role: kAXTextFieldRole as String,
            valueSettable: false,
            selectedTextSettable: false,
            editableAncestorAvailable: false
        ),
        immediateValue == 1,
        immediateLookups == 1,
        immediateWaits == 0,
        delayedValue == 7,
        delayedLookups == 3,
        delayedWaits == 2,
        exhaustedValue == nil,
        exhaustedLookups == 3,
        exhaustedWaits == 2,
        editableAncestorRelationshipIsAllowed(
            candidateDiffers: true,
            sameProcess: true,
            inParentChain: true,
            sameWindow: true,
            candidateEditable: true
        ),
        !editableAncestorRelationshipIsAllowed(
            candidateDiffers: false,
            sameProcess: true,
            inParentChain: true,
            sameWindow: true,
            candidateEditable: true
        ),
        !editableAncestorRelationshipIsAllowed(
            candidateDiffers: true,
            sameProcess: false,
            inParentChain: true,
            sameWindow: true,
            candidateEditable: true
        ),
        !editableAncestorRelationshipIsAllowed(
            candidateDiffers: true,
            sameProcess: true,
            inParentChain: false,
            sameWindow: true,
            candidateEditable: true
        ),
        !editableAncestorRelationshipIsAllowed(
            candidateDiffers: true,
            sameProcess: true,
            inParentChain: true,
            sameWindow: false,
            candidateEditable: true
        ),
        !editableAncestorRelationshipIsAllowed(
            candidateDiffers: true,
            sameProcess: true,
            inParentChain: true,
            sameWindow: true,
            candidateEditable: false
        ),
        !editabilityFromCapabilities(
            role: kAXStaticTextRole as String,
            subrole: nil,
            enabled: true,
            valueSettable: true,
            selectedTextSettable: true,
            selectedTextRangeSettable: true
        ),
        !editabilityFromCapabilities(
            role: kAXTextFieldRole as String,
            subrole: kAXSecureTextFieldSubrole as String,
            enabled: true,
            valueSettable: true,
            selectedTextSettable: true,
            selectedTextRangeSettable: true
        ),
        !editabilityFromCapabilities(
            role: kAXTextAreaRole as String,
            subrole: nil,
            enabled: false,
            valueSettable: true,
            selectedTextSettable: true,
            selectedTextRangeSettable: true
        ),
        let holdShortcut = parseHoldShortcut("Command+Control"),
        holdShortcut.modifierOnly,
        holdShortcut.groups.count == 2,
        parseHoldShortcut("Control+Space")?.modifierOnly == false,
        parseHoldShortcut("F21") == nil,
        let expectation = parsePasteExpectation([
            "darwin",
            "42",
            "com.example.Editor",
            fingerprint,
            elementFingerprint,
            "7",
        ]),
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

private func keyIsDown(_ keyCode: CGKeyCode) -> Bool {
    CGEventSource.keyState(.combinedSessionState, key: keyCode)
}

private let macKeyCodes: [String: CGKeyCode] = [
    "A": 0, "S": 1, "D": 2, "F": 3, "H": 4, "G": 5,
    "Z": 6, "X": 7, "C": 8, "V": 9, "B": 11, "Q": 12,
    "W": 13, "E": 14, "R": 15, "Y": 16, "T": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23,
    "Equal": 24, "9": 25, "7": 26, "Minus": 27, "8": 28, "0": 29,
    "BracketRight": 30, "O": 31, "U": 32, "BracketLeft": 33,
    "I": 34, "P": 35, "Return": 36, "Enter": 36, "L": 37,
    "J": 38, "Quote": 39, "K": 40, "Semicolon": 41,
    "Backslash": 42, "Comma": 43, "Slash": 44, "N": 45,
    "M": 46, "Period": 47, "Tab": 48, "Space": 49,
    "Backquote": 50, "Backspace": 51, "Escape": 53,
    "CapsLock": 57, "numdec": 65, "nummult": 67, "numadd": 69,
    "NumLock": 71, "numdiv": 75, "NumpadEnter": 76, "numsub": 78,
    "num0": 82, "num1": 83, "num2": 84, "num3": 85, "num4": 86,
    "num5": 87, "num6": 88, "num7": 89, "num8": 91, "num9": 92,
    "F5": 96, "F6": 97, "F7": 98, "F3": 99, "F8": 100,
    "F9": 101, "F11": 103, "F13": 105, "F16": 106, "F14": 107,
    "F10": 109, "F12": 111, "F15": 113, "Insert": 114,
    "Home": 115, "PageUp": 116, "Delete": 117, "F4": 118,
    "End": 119, "F2": 120, "PageDown": 121, "F1": 122,
    "Left": 123, "Right": 124, "Down": 125, "Up": 126,
    "F17": 64, "F18": 79, "F19": 80, "F20": 90,
]

private let modifierTokens: Set<String> = [
    "CommandOrControl", "Command", "Control", "Alt", "AltGr",
    "Shift", "Super", "Meta",
]

private func keyGroups(for token: String) -> [[CGKeyCode]]? {
    switch token {
    case "CommandOrControl", "Command", "Super", "Meta": return [[55, 54]]
    case "Control": return [[59, 62]]
    case "Alt": return [[58, 61]]
    case "AltGr": return [[61]]
    case "Shift": return [[56, 60]]
    case "Plus": return [[56, 60], [24]]
    default:
        guard let keyCode = macKeyCodes[token] else { return nil }
        return [[keyCode]]
    }
}

private func parseHoldShortcut(_ shortcut: String) -> (groups: [[CGKeyCode]], modifierOnly: Bool)? {
    let tokens = shortcut.split(separator: "+", omittingEmptySubsequences: false).map(String.init)
    guard !tokens.isEmpty, tokens.count <= 8, !tokens.contains(where: { $0.isEmpty }) else {
        return nil
    }
    var groups: [[CGKeyCode]] = []
    var identities = Set<String>()
    for token in tokens {
        guard let tokenGroups = keyGroups(for: token) else { return nil }
        for group in tokenGroups {
            let identity = group.sorted().map(String.init).joined(separator: ",")
            if identities.insert(identity).inserted { groups.append(group) }
        }
    }
    guard !groups.isEmpty else { return nil }
    return (groups, tokens.allSatisfy(modifierTokens.contains))
}

private func anyRequiredKeyIsDown(_ groups: [[CGKeyCode]]) -> Bool {
    groups.contains { group in group.contains(where: keyIsDown) }
}

private func allRequiredKeysAreDown(_ groups: [[CGKeyCode]]) -> Bool {
    groups.allSatisfy { group in group.contains(where: keyIsDown) }
}

private func anotherKeyIsDown(excluding required: Set<CGKeyCode>) -> Bool {
    for rawKeyCode in 0...127 {
        let keyCode = CGKeyCode(rawKeyCode)
        if required.contains(keyCode) { continue }
        if keyIsDown(keyCode) { return true }
    }
    return false
}

private func anyMouseButtonIsDown() -> Bool {
    CGEventSource.buttonState(.combinedSessionState, button: .left)
        || CGEventSource.buttonState(.combinedSessionState, button: .right)
        || CGEventSource.buttonState(.combinedSessionState, button: .center)
}

private func monitorHoldShortcut(_ shortcut: String) throws -> Never {
    guard let parsed = parseHoldShortcut(shortcut) else { throw HelperError.invalidCommand }
    let required = Set(parsed.groups.flatMap { $0 })
    var chordWasDown = false
    var suppressedUntilRelease = false
    var iterations = 0

    while true {
        if iterations % 125 == 0 && getppid() == 1 { exit(0) }
        iterations &+= 1

        let anyRequiredDown = anyRequiredKeyIsDown(parsed.groups)
        let allRequiredDown = allRequiredKeysAreDown(parsed.groups)

        if suppressedUntilRelease {
            if chordWasDown && !allRequiredDown {
                try writeJSON(ControlEventPayload(event: "hold-up"))
                chordWasDown = false
            }
            if !anyRequiredDown { suppressedUntilRelease = false }
            Thread.sleep(forTimeInterval: 0.008)
            continue
        }

        let partialChordModified = anyRequiredDown
            && !allRequiredDown
            && anotherKeyIsDown(excluding: required)
        let pendingModifierChordModified = parsed.modifierOnly
            && allRequiredDown
            && anotherKeyIsDown(excluding: required)
        let mouseModified = anyRequiredDown && anyMouseButtonIsDown()
        if partialChordModified || pendingModifierChordModified || mouseModified {
            try writeJSON(ControlEventPayload(event: "modified-input"))
            suppressedUntilRelease = true
        } else if allRequiredDown && !chordWasDown {
            chordWasDown = true
            try writeJSON(ControlEventPayload(event: "hold-down"))
        } else if chordWasDown && !allRequiredDown {
            try writeJSON(ControlEventPayload(event: "hold-up"))
            chordWasDown = false
            suppressedUntilRelease = true
        }

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
    case "hold-monitor":
        guard CommandLine.arguments.count == 3 else { throw HelperError.invalidCommand }
        try monitorHoldShortcut(CommandLine.arguments[2])
    default:
        throw HelperError.invalidCommand
    }
} catch {
    FileHandle.standardError.write(Data("active-target helper failed\n".utf8))
    exit(2)
}
