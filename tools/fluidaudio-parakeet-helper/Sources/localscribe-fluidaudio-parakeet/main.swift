@preconcurrency import AVFoundation
import CoreML
import FluidAudio
import Foundation

private let protocolVersion = 1
private let runtimeVersion = "0.15.5"
private let maximumFrameBytes = 32 * 1024 * 1024
private let maximumPcmBytes = 20_971_520
private let expectedModelDirectoryNames: [ParakeetPrecision: String] = [
    .fp16: "parakeet-unified-en-0-6b-coreml-fp16",
    .int8: "parakeet-unified-en-0-6b-coreml-int8",
]

private enum HelperError: Error {
    case malformedFrame
    case frameTooLarge
    case malformedRequest
    case invalidModelPath
    case pcmLengthInvalid
    case modelNotLoaded
}

private func errorCode(_ error: Error) -> String {
    switch error {
    case HelperError.malformedFrame, HelperError.malformedRequest:
        return "invalid_request"
    case HelperError.frameTooLarge, HelperError.pcmLengthInvalid:
        return "request_too_large"
    case HelperError.invalidModelPath:
        return "invalid_model_path"
    case HelperError.modelNotLoaded:
        return "model_not_loaded"
    default:
        return "runtime_failure"
    }
}

private func readExactly(_ count: Int) throws -> Data? {
    guard count >= 0 else { throw HelperError.malformedFrame }
    var result = Data()
    result.reserveCapacity(count)
    while result.count < count {
        let remaining = count - result.count
        let part = FileHandle.standardInput.readData(ofLength: remaining)
        if part.isEmpty {
            if result.isEmpty { return nil }
            throw HelperError.malformedFrame
        }
        result.append(part)
    }
    return result
}

private func readFrame() throws -> Data? {
    guard let header = try readExactly(4) else { return nil }
    guard header.count == 4 else { throw HelperError.malformedFrame }
    let declaredLength = header.withUnsafeBytes { rawBuffer in
        rawBuffer.loadUnaligned(as: UInt32.self).bigEndian
    }
    guard declaredLength <= UInt32(maximumFrameBytes) else { throw HelperError.frameTooLarge }
    guard let payload = try readExactly(Int(declaredLength)), payload.count == Int(declaredLength) else {
        throw HelperError.malformedFrame
    }
    return payload
}

private func writeFrame(_ object: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(object),
          let payload = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
          payload.count <= maximumFrameBytes
    else {
        return
    }
    var length = UInt32(payload.count).bigEndian
    var frame = Data(bytes: &length, count: MemoryLayout<UInt32>.size)
    frame.append(payload)
    FileHandle.standardOutput.write(frame)
}

private func dictionary(from data: Data) throws -> [String: Any] {
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw HelperError.malformedRequest
    }
    return object
}

private func exactString(_ request: [String: Any], _ key: String) throws -> String {
    guard let value = request[key] as? String, !value.isEmpty else {
        throw HelperError.malformedRequest
    }
    return value
}

private func exactInteger(_ request: [String: Any], _ key: String) throws -> Int {
    guard let number = request[key] as? NSNumber,
          CFGetTypeID(number) != CFBooleanGetTypeID(),
          number.int64Value >= 0,
          number.int64Value <= Int64(Int.max),
          number.doubleValue == Double(number.int64Value)
    else {
        throw HelperError.malformedRequest
    }
    return Int(number.int64Value)
}

private enum ParakeetMode: String {
    case afterStop = "after-stop"
    case live
}

private enum ParakeetPrecision: String {
    case fp16 = "coreml-fp16"
    case int8 = "coreml-int8"

    var fluidAudio: UnifiedEncoderPrecision {
        switch self {
        case .fp16: return .fp16
        case .int8: return .int8
        }
    }
}

private final class ParakeetRuntime {
    private var offlineManager: UnifiedAsrManager?
    private var liveManager: StreamingUnifiedAsrManager?
    private var mode: ParakeetMode?

    private func samples(from pcm16: Data) throws -> [Float] {
        guard !pcm16.isEmpty, pcm16.count <= maximumPcmBytes, pcm16.count.isMultiple(of: 2) else {
            throw HelperError.pcmLengthInvalid
        }
        let count = pcm16.count / 2
        var output = [Float]()
        output.reserveCapacity(count)
        pcm16.withUnsafeBytes { rawBuffer in
            for offset in stride(from: 0, to: pcm16.count, by: 2) {
                let sample = rawBuffer.loadUnaligned(fromByteOffset: offset, as: Int16.self)
                output.append(Float(Int16(littleEndian: sample)) / 32768.0)
            }
        }
        return output
    }

    private func makeBuffer(samples: [Float]) throws -> AVAudioPCMBuffer {
        let format = AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1)!
        guard let buffer = AVAudioPCMBuffer(
            pcmFormat: format,
            frameCapacity: AVAudioFrameCount(samples.count)
        ), let destination = buffer.floatChannelData?[0] else {
            throw HelperError.malformedRequest
        }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { source in
            destination.initialize(from: source.baseAddress!, count: samples.count)
        }
        return buffer
    }

    func load(modelPath: String, precision: ParakeetPrecision, mode: ParakeetMode) async throws {
        let url = URL(fileURLWithPath: modelPath, isDirectory: true).standardizedFileURL
        guard url.path.hasPrefix("/"),
              url.lastPathComponent == expectedModelDirectoryNames[precision],
              !url.pathComponents.contains("..")
        else {
            throw HelperError.invalidModelPath
        }
        // The Python worker has already completed a strict per-file size and
        // SHA-256 verification. FluidAudio is deliberately offline here: a
        // damaged CoreML bundle must become a repairable error, never trigger
        // an unpinned redownload or alter the verified model directory.
        ModelHub.offlineMode = true
        let configuration = MLModelConfiguration()
        // The encoder is the only large graph. Pin it to ANE instead of letting
        // CoreML opportunistically contend with Electron/MLX on the GPU. The
        // decoder/joint remain CPU-only inside FluidAudio because they are tiny
        // per-token graphs. This is particularly important on a warm M4 Max
        // dictation process where predictable latency matters more than a
        // synthetic throughput maximum.
        configuration.computeUnits = .cpuAndNeuralEngine
        await close()
        switch mode {
        case .afterStop:
            let freshManager = UnifiedAsrManager(
                configuration: configuration,
                encoderPrecision: precision.fluidAudio
            )
            try await freshManager.loadModels(from: url)
            offlineManager = freshManager
        case .live:
            let freshManager = StreamingUnifiedAsrManager(
                configuration: configuration,
                config: UnifiedConfig(leftFrames: 70, chunkFrames: 7, rightFrames: 7),
                encoderPrecision: precision.fluidAudio
            )
            try await freshManager.loadModels(from: url)
            liveManager = freshManager
        }
        self.mode = mode
    }

    func transcribe(pcm16: Data) async throws -> String {
        guard mode == .afterStop, let offlineManager else { throw HelperError.modelNotLoaded }
        let text = try await offlineManager.transcribe(try samples(from: pcm16))
        guard text.utf8.count <= 100_000 else { throw HelperError.malformedRequest }
        return text
    }

    func append(pcm16: Data) async throws -> String {
        guard mode == .live, let liveManager else { throw HelperError.modelNotLoaded }
        try await liveManager.appendAudio(makeBuffer(samples: try samples(from: pcm16)))
        try await liveManager.processBufferedAudio()
        let text = await liveManager.getPartialTranscript()
        guard text.utf8.count <= 100_000 else { throw HelperError.malformedRequest }
        return text
    }

    func finish() async throws -> String {
        guard mode == .live, let liveManager else { throw HelperError.modelNotLoaded }
        let text = try await liveManager.finish()
        guard text.utf8.count <= 100_000 else { throw HelperError.malformedRequest }
        return text
    }

    func reset() async throws {
        guard mode == .live, let liveManager else { throw HelperError.modelNotLoaded }
        try await liveManager.reset()
    }

    func close() async {
        await offlineManager?.cleanup()
        await liveManager?.cleanup()
        offlineManager = nil
        liveManager = nil
        mode = nil
    }
}

@main
struct LocalScribeFluidAudioParakeet {
    static func main() async {
        let runtime = ParakeetRuntime()
        writeFrame([
            "type": "hello",
            "protocol": protocolVersion,
            "runtime": "FluidAudio CoreML / ANE",
            "runtimeVersion": runtimeVersion,
            "modes": ["after-stop", "live"],
            "precisions": ["coreml-fp16", "coreml-int8"],
        ])
        while true {
            do {
                guard let payload = try readFrame() else {
                    await runtime.close()
                    return
                }
                let request = try dictionary(from: payload)
                let type = try exactString(request, "type")
                switch type {
                case "load":
                    guard Set(request.keys) == Set(["type", "modelPath", "precision", "mode"]) else {
                        throw HelperError.malformedRequest
                    }
                    guard let precision = ParakeetPrecision(rawValue: try exactString(request, "precision")),
                          let mode = ParakeetMode(rawValue: try exactString(request, "mode")) else {
                        throw HelperError.malformedRequest
                    }
                    try await runtime.load(
                        modelPath: try exactString(request, "modelPath"),
                        precision: precision,
                        mode: mode
                    )
                    writeFrame(["type": "loaded"])
                case "transcribe":
                    guard Set(request.keys) == Set(["type", "pcmBytes"]) else {
                        throw HelperError.malformedRequest
                    }
                    let pcmBytes = try exactInteger(request, "pcmBytes")
                    guard pcmBytes > 0, pcmBytes <= maximumPcmBytes, pcmBytes.isMultiple(of: 2),
                          let pcm = try readExactly(pcmBytes), pcm.count == pcmBytes
                    else {
                        throw HelperError.pcmLengthInvalid
                    }
                    writeFrame(["type": "transcription", "text": try await runtime.transcribe(pcm16: pcm)])
                case "append":
                    guard Set(request.keys) == Set(["type", "pcmBytes"]) else {
                        throw HelperError.malformedRequest
                    }
                    let pcmBytes = try exactInteger(request, "pcmBytes")
                    guard pcmBytes > 0, pcmBytes <= maximumPcmBytes, pcmBytes.isMultiple(of: 2),
                          let pcm = try readExactly(pcmBytes), pcm.count == pcmBytes
                    else {
                        throw HelperError.pcmLengthInvalid
                    }
                    writeFrame(["type": "partial", "text": try await runtime.append(pcm16: pcm)])
                case "finish":
                    guard Set(request.keys) == Set(["type"]) else { throw HelperError.malformedRequest }
                    writeFrame(["type": "transcription", "text": try await runtime.finish()])
                case "reset":
                    guard Set(request.keys) == Set(["type"]) else { throw HelperError.malformedRequest }
                    try await runtime.reset()
                    writeFrame(["type": "reset"])
                case "close":
                    guard Set(request.keys) == Set(["type"]) else { throw HelperError.malformedRequest }
                    await runtime.close()
                    writeFrame(["type": "closed"])
                    return
                default:
                    throw HelperError.malformedRequest
                }
            } catch {
                writeFrame(["type": "error", "code": errorCode(error)])
            }
        }
    }
}
