import AVFoundation
import AVKit
import CoreMedia
import CoreVideo
import ExpoModulesCore
import UIKit

// Teleprompter flutuante: desenha o roteiro rolando num vídeo "ao vivo"
// e mostra esse vídeo na janela Picture-in-Picture do iOS.
public final class TeleprompterPipModule: Module {
  private var engine: PipEngine?

  public func definition() -> ModuleDefinition {
    Name("TeleprompterPip")

    Events("onPlayingChange", "onActiveChange")

    Function("isSupported") { () -> Bool in
      return AVPictureInPictureController.isPictureInPictureSupported()
    }

    Function("update") { (opts: [String: Any]) in
      DispatchQueue.main.async {
        self.ensureEngine().update(opts)
      }
    }

    AsyncFunction("start") { () -> Bool in
      return self.ensureEngine().start()
    }.runOnQueue(.main)

    AsyncFunction("stop") { () in
      self.engine?.stop()
    }.runOnQueue(.main)
  }

  // Sempre chamado na main thread.
  @discardableResult
  private func ensureEngine() -> PipEngine {
    if let e = engine { return e }
    let e = PipEngine()
    e.onPlayingChange = { [weak self] playing in
      self?.sendEvent("onPlayingChange", ["playing": playing])
    }
    e.onActiveChange = { [weak self] active in
      self?.sendEvent("onActiveChange", ["active": active])
    }
    engine = e
    return e
  }
}

final class PipEngine: NSObject, AVPictureInPictureControllerDelegate, AVPictureInPictureSampleBufferPlaybackDelegate {
  // Tamanho do "vídeo" desenhado (3:2)
  private let width = 960
  private let height = 640
  private let margin: CGFloat = 44

  private let displayLayer = AVSampleBufferDisplayLayer()
  private let hostView = UIView(frame: CGRect(x: 0, y: 0, width: 2, height: 2))
  private var controller: AVPictureInPictureController?
  private let renderQueue = DispatchQueue(label: "teleprompter.pip.render")
  private var timer: DispatchSourceTimer?
  private var pool: CVPixelBufferPool?

  // Texto (só mexido na renderQueue)
  private let storage = NSTextStorage()
  private let layoutManager = NSLayoutManager()
  private let container: NSTextContainer
  private var text = ""
  private var fontSize: CGFloat = 32
  private var speed: CGFloat = 4
  private var playing = false
  private var follow = false
  private var followChar = 0
  private var offset: CGFloat = 0
  private var lastTick: CFTimeInterval = 0
  private var needsRender = true
  private var idleFrames = 0

  // Lido na main thread pelo PiP
  private var playingFlag = false

  var onPlayingChange: ((Bool) -> Void)?
  var onActiveChange: ((Bool) -> Void)?

  private var pxFont: CGFloat { max(24, fontSize * 2.6) }
  private var markY: CGFloat { CGFloat(height) * 0.2 }

  override init() {
    container = NSTextContainer(size: CGSize(width: CGFloat(960) - 2 * 44, height: CGFloat.greatestFiniteMagnitude))
    super.init()
    container.lineFragmentPadding = 0
    layoutManager.addTextContainer(container)
    storage.addLayoutManager(layoutManager)

    displayLayer.videoGravity = .resizeAspect
    displayLayer.frame = hostView.bounds
    displayLayer.backgroundColor = UIColor.black.cgColor
    hostView.isUserInteractionEnabled = false
    hostView.layer.addSublayer(displayLayer)

    createPool()
    attachHostView()

    let source = AVPictureInPictureController.ContentSource(sampleBufferDisplayLayer: displayLayer, playbackDelegate: self)
    let c = AVPictureInPictureController(contentSource: source)
    c.delegate = self
    c.requiresLinearPlayback = false
    controller = c

    renderQueue.async {
      self.relayout()
      self.renderFrame()
    }
    startTimer()
  }

  // MARK: - Controle

  func update(_ opts: [String: Any]) {
    let newText = opts["text"] as? String
    let newSize = (opts["fontSize"] as? NSNumber).map { CGFloat(truncating: $0) }
    let newSpeed = (opts["speed"] as? NSNumber).map { CGFloat(truncating: $0) }
    let newPlaying = opts["playing"] as? Bool
    let newFollow = opts["follow"] as? Bool
    let newFollowChar = (opts["followChar"] as? NSNumber)?.intValue
    let jump = opts["jump"] as? String

    if let p = newPlaying {
      playingFlag = p
      controller?.invalidatePlaybackState()
    }

    renderQueue.async {
      var layoutChanged = false
      if let t = newText, t != self.text { self.text = t; layoutChanged = true }
      if let s = newSize, s > 0, s != self.fontSize { self.fontSize = s; layoutChanged = true }
      if layoutChanged { self.relayout() }
      if let s = newSpeed, s > 0 { self.speed = s }
      if let p = newPlaying { self.playing = p }
      if let f = newFollow { self.follow = f }
      if let c = newFollowChar { self.followChar = max(0, c) }
      if let j = jump { self.applyJump(j) }
      self.needsRender = true
    }
  }

  func start() -> Bool {
    attachHostView()
    activateAudio()
    guard let c = controller else { return false }
    renderQueue.async { self.needsRender = true; self.renderFrame() }
    if c.isPictureInPicturePossible {
      c.startPictureInPicture()
      return true
    }
    // O iOS pode demorar alguns instantes para liberar o PiP
    var tries = 0
    func retry() {
      tries += 1
      if c.isPictureInPicturePossible {
        c.startPictureInPicture()
      } else if tries < 10 {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { retry() }
      } else {
        self.onActiveChange?(false)
      }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { retry() }
    return true
  }

  func stop() {
    controller?.stopPictureInPicture()
  }

  private func activateAudio() {
    let session = AVAudioSession.sharedInstance()
    try? session.setCategory(.playback, mode: .moviePlayback, options: [.mixWithOthers])
    try? session.setActive(true)
  }

  private func attachHostView() {
    if hostView.window != nil { return }
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let windows = scenes.flatMap { $0.windows }
    guard let window = windows.first(where: { $0.isKeyWindow }) ?? windows.first else { return }
    hostView.frame = CGRect(x: 0, y: window.bounds.height - 2, width: 2, height: 2)
    window.addSubview(hostView)
  }

  // MARK: - Texto e rolagem (renderQueue)

  private func relayout() {
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineHeightMultiple = 1.15
    let attrs: [NSAttributedString.Key: Any] = [
      .font: UIFont.systemFont(ofSize: pxFont, weight: .bold),
      .foregroundColor: UIColor.white,
      .paragraphStyle: paragraph,
    ]
    storage.setAttributedString(NSAttributedString(string: text, attributes: attrs))
    layoutManager.ensureLayout(for: container)
    offset = min(offset, maxOffset())
  }

  private func maxOffset() -> CGFloat {
    let used = layoutManager.usedRect(for: container).height
    return max(0, used - pxFont * 1.2)
  }

  private func yForChar(_ c: Int) -> CGFloat {
    let length = storage.length
    if length == 0 { return 0 }
    let glyph = layoutManager.glyphIndexForCharacter(at: min(c, length - 1))
    return layoutManager.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil).minY
  }

  private func applyJump(_ j: String) {
    switch j {
    case "top":
      offset = 0
      playing = false
      notifyPlaying(false)
    case "back":
      offset = max(0, offset - CGFloat(height) * 0.5)
    case "fwd":
      offset = min(maxOffset(), offset + CGFloat(height) * 0.5)
    default:
      break
    }
  }

  private func notifyPlaying(_ p: Bool) {
    DispatchQueue.main.async {
      self.playingFlag = p
      self.controller?.invalidatePlaybackState()
      self.onPlayingChange?(p)
    }
  }

  private func startTimer() {
    let t = DispatchSource.makeTimerSource(queue: renderQueue)
    t.schedule(deadline: .now(), repeating: .milliseconds(33))
    t.setEventHandler { [weak self] in self?.tick() }
    t.resume()
    timer = t
  }

  private func tick() {
    let now = CACurrentMediaTime()
    let dt = lastTick == 0 ? 0 : min(0.1, now - lastTick)
    lastTick = now
    let before = offset

    if follow {
      let target = min(maxOffset(), yForChar(followChar))
      offset += (target - offset) * CGFloat(min(1, dt * 8))
    } else if playing {
      offset += CGFloat(dt) * speed * pxFont * 0.32
      if offset >= maxOffset() {
        offset = maxOffset()
        playing = false
        notifyPlaying(false)
      }
    }

    if abs(offset - before) > 0.01 { needsRender = true }
    idleFrames += 1
    // parado: um quadro a cada ~0,5 s para a janela continuar viva
    if needsRender || idleFrames >= 15 {
      renderFrame()
    }
  }

  // MARK: - Desenho (renderQueue)

  private func createPool() {
    let attrs: [String: Any] = [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
      kCVPixelBufferWidthKey as String: width,
      kCVPixelBufferHeightKey as String: height,
      kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any](),
      kCVPixelBufferCGImageCompatibilityKey as String: true,
      kCVPixelBufferCGBitmapContextCompatibilityKey as String: true,
    ]
    CVPixelBufferPoolCreate(nil, nil, attrs as CFDictionary, &pool)
  }

  private func renderFrame() {
    needsRender = false
    idleFrames = 0
    guard let pool = pool else { return }
    var pbOut: CVPixelBuffer?
    CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pbOut)
    guard let pb = pbOut else { return }

    CVPixelBufferLockBaseAddress(pb, [])
    guard let base = CVPixelBufferGetBaseAddress(pb),
          let ctx = CGContext(
            data: base,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: CVPixelBufferGetBytesPerRow(pb),
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
          )
    else {
      CVPixelBufferUnlockBaseAddress(pb, [])
      return
    }

    let full = CGRect(x: 0, y: 0, width: width, height: height)
    ctx.setFillColor(UIColor.black.cgColor)
    ctx.fill(full)

    // coordenadas do UIKit (origem no topo)
    ctx.translateBy(x: 0, y: CGFloat(height))
    ctx.scaleBy(x: 1, y: -1)
    UIGraphicsPushContext(ctx)

    let origin = CGPoint(x: margin, y: markY - offset)
    let visible = CGRect(x: 0, y: offset - markY, width: container.size.width, height: CGFloat(height))
    if storage.length > 0 {
      let range = layoutManager.glyphRange(forBoundingRect: visible, in: container)
      layoutManager.drawGlyphs(forGlyphRange: range, at: origin)
    }

    // faixas escuras em cima e embaixo, e a linha de leitura
    ctx.setFillColor(UIColor(white: 0, alpha: 0.55).cgColor)
    ctx.fill(CGRect(x: 0, y: 0, width: CGFloat(width), height: markY - 8))
    ctx.setFillColor(UIColor(red: 0.9, green: 0.15, blue: 0.1, alpha: 0.9).cgColor)
    ctx.fill(CGRect(x: 0, y: markY - 3, width: CGFloat(width), height: 4))

    UIGraphicsPopContext()
    CVPixelBufferUnlockBaseAddress(pb, [])

    enqueue(pb)
  }

  private func enqueue(_ pb: CVPixelBuffer) {
    var format: CMVideoFormatDescription?
    CMVideoFormatDescriptionCreateForImageBuffer(allocator: nil, imageBuffer: pb, formatDescriptionOut: &format)
    guard let fmt = format else { return }
    var timing = CMSampleTimingInfo(
      duration: CMTime(value: 1, timescale: 30),
      presentationTimeStamp: CMClockGetTime(CMClockGetHostTimeClock()),
      decodeTimeStamp: .invalid
    )
    var sampleOut: CMSampleBuffer?
    CMSampleBufferCreateReadyWithImageBuffer(
      allocator: nil,
      imageBuffer: pb,
      formatDescription: fmt,
      sampleTiming: &timing,
      sampleBufferOut: &sampleOut
    )
    guard let sample = sampleOut else { return }
    if let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: true),
       CFArrayGetCount(attachments) > 0 {
      let dict = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
      CFDictionarySetValue(
        dict,
        Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
        Unmanaged.passUnretained(kCFBooleanTrue).toOpaque()
      )
    }
    if displayLayer.status == .failed {
      displayLayer.flush()
    }
    displayLayer.enqueue(sample)
  }

  // MARK: - AVPictureInPictureSampleBufferPlaybackDelegate

  func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController, setPlaying playing: Bool) {
    playingFlag = playing
    pictureInPictureController.invalidatePlaybackState()
    renderQueue.async {
      if self.follow && playing { return }
      self.playing = playing
    }
    onPlayingChange?(playing)
  }

  func pictureInPictureControllerTimeRangeForPlayback(_ pictureInPictureController: AVPictureInPictureController) -> CMTimeRange {
    return CMTimeRange(start: .negativeInfinity, duration: .positiveInfinity)
  }

  func pictureInPictureControllerIsPlaybackPaused(_ pictureInPictureController: AVPictureInPictureController) -> Bool {
    return !playingFlag
  }

  func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController, didTransitionToRenderSize newRenderSize: CMVideoDimensions) {}

  func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController, skipByInterval skipInterval: CMTime, completion completionHandler: @escaping () -> Void) {
    let seconds = CGFloat(CMTimeGetSeconds(skipInterval))
    renderQueue.async {
      self.offset = max(0, min(self.maxOffset(), self.offset + seconds * self.speed * self.pxFont * 0.32))
      self.needsRender = true
    }
    completionHandler()
  }

  // MARK: - AVPictureInPictureControllerDelegate

  func pictureInPictureControllerDidStartPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
    onActiveChange?(true)
  }

  func pictureInPictureControllerDidStopPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
    onActiveChange?(false)
  }

  func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController, failedToStartPictureInPictureWithError error: Error) {
    onActiveChange?(false)
  }

  func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController, restoreUserInterfaceForPictureInPictureStopWithCompletionHandler completionHandler: @escaping (Bool) -> Void) {
    completionHandler(true)
  }
}
