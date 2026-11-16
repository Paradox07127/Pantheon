// The built-in voice engine: transcribes the microphone, or a file, with the system's on-device speech model.
// pantheon-voice --locale <BCP 47> [--record <path>] [--file <path>]
// Writes one JSON event per line; a "stop" line on stdin ends the recording, a closed stdin cancels.
import AVFoundation
import Foundation
import Speech

let output = FileHandle.standardOutput
let outputLock = NSLock()

func emit(_ event: [String: Any]) {
  var line = try! JSONSerialization.data(withJSONObject: event)
  line.append(0x0A)
  outputLock.lock()
  output.write(line)
  outputLock.unlock()
}

func fail(_ code: String, _ message: String) -> Never {
  emit(["type": "error", "code": code, "message": message])
  exit(1)
}

func argument(_ name: String) -> String? {
  let args = CommandLine.arguments
  guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
  return args[index + 1]
}

let locale = Locale(identifier: argument("--locale") ?? "en-US")
let recordPath = argument("--record")
let filePath = argument("--file")

/// Reads stdin on its own thread: "stop" runs onStop once, end of input cancels.
func watchInput(onStop: @escaping @Sendable () -> Void) {
  Thread.detachNewThread {
    var stopped = false
    while let line = readLine() {
      if line.trimmingCharacters(in: .whitespaces) == "stop" && !stopped {
        stopped = true
        onStop()
      }
    }
    exit(1)
  }
}

func microphoneAllowed() async -> Bool {
  switch AVCaptureDevice.authorizationStatus(for: .audio) {
  case .authorized: return true
  case .notDetermined: return await AVCaptureDevice.requestAccess(for: .audio)
  default: return false
  }
}

/// Root mean square of the first channel, clamped to 0...1.
func level(of buffer: AVAudioPCMBuffer) -> Double {
  guard let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
  var sum: Float = 0
  for index in 0..<Int(buffer.frameLength) { sum += samples[index] * samples[index] }
  return min(1, Double((sum / Float(buffer.frameLength)).squareRoot()))
}

guard SpeechTranscriber.isAvailable else {
  fail("unavailable", "On-device speech transcription is not available on this Mac")
}
guard let supported = await SpeechTranscriber.supportedLocale(equivalentTo: locale) else {
  fail("unavailable", "Speech transcription does not support \(locale.identifier)")
}
let transcriber = SpeechTranscriber(
  locale: supported,
  transcriptionOptions: [],
  reportingOptions: [.volatileResults],
  attributeOptions: []
)

if await AssetInventory.status(forModules: [transcriber]) != .installed {
  emit(["type": "preparing"])
  do {
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
      let observation = request.progress.observe(\.fractionCompleted) { progress, _ in
        emit(["type": "preparing", "progress": min(1, max(0, progress.fractionCompleted))])
      }
      try await request.downloadAndInstall()
      observation.invalidate()
    }
  } catch {
    fail("unavailable", "The speech model for \(supported.identifier) could not be installed: \(error.localizedDescription)")
  }
}

let analyzer = SpeechAnalyzer(modules: [transcriber])

/// Collects results until the analyzer finishes, writing what is heard so far after each one.
let transcript = Task { () throws -> String in
  var settled = ""
  for try await result in transcriber.results {
    let text = String(result.text.characters)
    if result.isFinal {
      settled += text
      emit(["type": "partial", "text": settled])
    } else {
      emit(["type": "partial", "text": settled + text])
    }
  }
  return settled
}

do {
  if let filePath {
    watchInput(onStop: {})
    let file = try AVAudioFile(forReading: URL(fileURLWithPath: filePath))
    emit(["type": "ready"])
    if let end = try await analyzer.analyzeSequence(from: file) {
      try await analyzer.finalizeAndFinish(through: end)
    } else {
      await analyzer.cancelAndFinishNow()
    }
  } else {
    guard await microphoneAllowed() else {
      fail("microphone_denied", "Pantheon is not allowed to use the microphone")
    }
    guard let analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
      fail("unavailable", "No audio format suits the speech model for \(supported.identifier)")
    }
    let engine = AVAudioEngine()
    let input = engine.inputNode
    let inputFormat = input.outputFormat(forBus: 0)
    guard inputFormat.sampleRate > 0, let converter = AVAudioConverter(from: inputFormat, to: analyzerFormat) else {
      fail("failed", "The microphone gives no audio")
    }
    let recording = try recordPath.map {
      try AVAudioFile(forWriting: URL(fileURLWithPath: $0), settings: inputFormat.settings)
    }
    let (inputs, feed) = AsyncStream.makeStream(of: AnalyzerInput.self)
    var lastLevel = Date.distantPast
    input.installTap(onBus: 0, bufferSize: 2048, format: inputFormat) { buffer, _ in
      try? recording?.write(from: buffer)
      let now = Date()
      if now.timeIntervalSince(lastLevel) >= 1.0 / 15 {
        lastLevel = now
        emit(["type": "level", "value": level(of: buffer)])
      }
      let capacity = AVAudioFrameCount(
        (Double(buffer.frameLength) * analyzerFormat.sampleRate / inputFormat.sampleRate).rounded(.up))
      guard let converted = AVAudioPCMBuffer(pcmFormat: analyzerFormat, frameCapacity: capacity) else { return }
      var consumed = false
      var error: NSError?
      converter.convert(to: converted, error: &error) { _, status in
        if consumed {
          status.pointee = .noDataNow
          return nil
        }
        consumed = true
        status.pointee = .haveData
        return buffer
      }
      if error == nil && converted.frameLength > 0 { feed.yield(AnalyzerInput(buffer: converted)) }
    }
    let stopped = AsyncStream<Void>.makeStream()
    watchInput(onStop: { stopped.continuation.finish() })
    try await analyzer.start(inputSequence: inputs)
    engine.prepare()
    try engine.start()
    emit(["type": "ready"])
    for await _ in stopped.stream {}
    engine.stop()
    input.removeTap(onBus: 0)
    feed.finish()
    try await analyzer.finalizeAndFinishThroughEndOfInput()
  }
  emit(["type": "final", "text": try await transcript.value])
  exit(0)
} catch {
  fail("failed", error.localizedDescription)
}
