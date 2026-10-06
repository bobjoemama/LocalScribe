@preconcurrency import AVFoundation
import CoreML
import FluidAudio
import Foundation
import MoonshineVoice

// Each helper owns one selected runtime. All loading consumes verified local
// files and explicitly selects compute units; no discovery/download API runs.
actor MoonshineRuntime {
    private var transcriber: Transcriber?
    private var stream: MoonshineVoice.Stream?
    private var mode: ParakeetMode?
    private var pending = 0
    private var latest = Transcript()

    func load(_ directory: URL, mode: ParakeetMode) throws {
        transcriber = try Transcriber(modelPath: directory.appendingPathComponent("model/small-streaming-en/quantized_26_08_21").path, modelArch: .smallStreaming,
            options: [TranscriberOption(name: "ort_providers", value: "cpu")])
        self.mode = mode
    }
    func reset() throws {
        stream = nil
        latest = Transcript()
        pending = 0
        guard let transcriber else { throw HelperError.modelNotLoaded }
        let fresh = try transcriber.createStream(updateInterval: 3600)
        try fresh.start()
        stream = fresh
    }
    private func text(_ transcript: Transcript) throws -> String {
        let value = transcript.lines.map(\.text).joined(separator: " ")
        guard value.utf8.count <= 100_000 else { throw HelperError.malformedRequest }
        return value
    }
    func append(_ samples: [Float]) throws -> String {
        guard mode == .live, let stream else { throw HelperError.modelNotLoaded }
        try stream.addAudio(samples, sampleRate: 16_000)
        pending += samples.count
        if pending >= 8_000 {
            latest = try stream.updateTranscription()
            pending = 0
        }
        return try text(latest)
    }
    func finish() throws -> String {
        guard let stream else { throw HelperError.modelNotLoaded }
        defer { self.stream = nil; pending = 0; latest = Transcript() }
        try stream.stop()
        // stop() suppresses native update failures; require an explicit update.
        return try text(stream.updateTranscription(flags: TranscribeStreamFlags.flagForceUpdate))
    }
    func transcribe(_ samples: [Float]) throws -> String {
        guard mode == .afterStop else { throw HelperError.modelNotLoaded }
        try reset()
        guard let stream else { throw HelperError.modelNotLoaded }
        for offset in stride(from: 0, to: samples.count, by: 32_000) {
            try stream.addAudio(Array(samples[offset..<min(samples.count, offset + 32_000)]), sampleRate: 16_000)
            _ = try stream.updateTranscription()
        }
        return try finish()
    }
    func close() {
        // Native owners close in deinit. Explicit close plus deinit frees twice.
        stream = nil
        transcriber = nil
        latest = Transcript()
        mode = nil
        pending = 0
    }
}

actor PhononRuntime {
    private var models: AsrModels?
    private var offline: AsrManager?
    private var windowed: SlidingWindowAsrManager?
    private var observer: Task<Void, Never>?
    private var mode: ParakeetMode?
    private var pending: [Float] = []
    private var firstWindow = true
    private var acknowledged = 0
    private var sampleCount = 0
    private var generation = UUID()

    func load(_ directory: URL, gpu: Bool, mode: ParakeetMode) async throws {
        guard #available(macOS 15, *) else { throw HelperError.unsupportedPlatform }
        let configuration = MLModelConfiguration()
        configuration.computeUnits = .cpuOnly
        func component(_ name: String, units: MLComputeUnits) throws -> MLModel {
            let config = MLModelConfiguration()
            config.computeUnits = units
            return try MLModel(contentsOf: directory.appendingPathComponent(name), configuration: config)
        }
        let vocabData = try Data(contentsOf: directory.appendingPathComponent("parakeet_vocab.json"))
        guard let rawVocabulary = try JSONSerialization.jsonObject(with: vocabData) as? [String: String] else {
            throw HelperError.malformedRequest
        }
        var vocabulary: [Int: String] = [:]
        for (key, value) in rawVocabulary {
            guard let token = Int(key), token >= 0 else { throw HelperError.malformedRequest }
            vocabulary[token] = value
        }
        guard (0..<AsrModelVersion.phonon2.blankId).allSatisfy({ vocabulary[$0] != nil }) else {
            throw HelperError.malformedRequest
        }
        let prepared = AsrModels(
            encoder: try component(gpu ? "Encoder_lut3.mlmodelc" : "Encoder_lut6.mlmodelc",
                units: gpu ? .cpuAndGPU : .cpuAndNeuralEngine),
            preprocessor: try component("Preprocessor.mlmodelc", units: .cpuOnly),
            decoder: try component("Decoder.mlmodelc", units: .cpuOnly),
            joint: try component("JointDecisionv3.mlmodelc", units: .cpuOnly),
            configuration: configuration, vocabulary: vocabulary, version: .phonon2)
        models = prepared
        self.mode = mode
        if mode == .afterStop {
            let manager = AsrManager()
            try await manager.loadModels(prepared)
            offline = manager
        }
    }
    func transcribe(_ samples: [Float]) async throws -> String {
        guard mode == .afterStop, let offline else { throw HelperError.modelNotLoaded }
        var decoderState = TdtDecoderState.make(decoderLayers: await offline.decoderLayerCount)
        let result = try await offline.transcribe(samples, decoderState: &decoderState)
        guard result.text.utf8.count <= 100_000 else { throw HelperError.malformedRequest }
        return result.text
    }
    func reset() async throws {
        guard mode == .live, let models else { throw HelperError.modelNotLoaded }
        observer?.cancel()
        observer = nil
        await windowed?.cleanup()
        windowed = nil
        generation = UUID()
        let token = generation
        pending = []
        firstWindow = true
        acknowledged = 0
        sampleCount = 0
        // Fifteen-second context with a three-second advance, matching iOS.
        let manager = SlidingWindowAsrManager(config: SlidingWindowAsrConfig(
            chunkSeconds: 3, hypothesisChunkSeconds: 1, leftContextSeconds: 10,
            rightContextSeconds: 2, minContextForConfirmation: 10, confirmationThreshold: 0.8))
        try await manager.loadModels(models)
        let updates = await manager.transcriptionUpdates
        observer = Task { [weak self] in
            for await _ in updates {
                guard !Task.isCancelled else { return }
                await self?.acknowledge(token)
            }
        }
        windowed = manager
        // This source selects streaming semantics; PCM is supplied explicitly,
        // and this API never creates an AVAudioEngine or microphone tap.
        try await manager.startStreaming(source: .microphone)
    }
    private func acknowledge(_ token: UUID) {
        if generation == token { acknowledged += 1 }
    }
    private func buffer(_ samples: [Float]) throws -> AVAudioPCMBuffer {
        guard let format = AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)),
              let destination = buffer.floatChannelData?[0] else { throw HelperError.malformedRequest }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { source in
            if let base = source.baseAddress { destination.update(from: base, count: samples.count) }
        }
        return buffer
    }
    private func waitForWindows(_ count: Int, seconds: Int) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(seconds))
        while acknowledged < count {
            try Task.checkCancellation()
            guard ContinuousClock.now < deadline else { throw HelperError.runtimeFailure }
            try await Task.sleep(for: .milliseconds(20))
        }
    }
    func append(_ samples: [Float]) async throws -> String {
        guard mode == .live, let windowed else { throw HelperError.modelNotLoaded }
        sampleCount += samples.count
        pending.append(contentsOf: samples)
        while pending.count >= (firstWindow ? 80_000 : 48_000) {
            let required = firstWindow ? 80_000 : 48_000
            let expected = acknowledged + 1
            await windowed.streamAudio(try buffer(Array(pending.prefix(required))))
            // Admit one window at a time, including silence. Upstream window
            // failures cannot silently drop words or accumulate unbounded PCM.
            try await waitForWindows(expected, seconds: 30)
            pending.removeFirst(required)
            firstWindow = false
        }
        let confirmed = await windowed.confirmedTranscript
        let volatile = await windowed.volatileTranscript
        let value = [confirmed, volatile].filter { !$0.isEmpty }.joined(separator: " ")
        guard value.utf8.count <= 100_000 else { throw HelperError.malformedRequest }
        return value
    }
    func finish() async throws -> String {
        guard mode == .live, let windowed else { throw HelperError.modelNotLoaded }
        if !pending.isEmpty { await windowed.streamAudio(try buffer(pending)); pending = [] }
        let text = try await windowed.finish()
        // finish() can suppress individual window failures; require every ack.
        try await waitForWindows(Int(ceil(Double(sampleCount) / 48_000)), seconds: 5)
        guard text.utf8.count <= 100_000 else { throw HelperError.malformedRequest }
        return text
    }
    func close() async {
        generation = UUID()
        observer?.cancel()
        observer = nil
        await windowed?.cleanup()
        await offline?.cleanup()
        windowed = nil
        offline = nil
        models = nil
        pending = []
        mode = nil
    }
}
