'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, Maximize2, Minimize2, Pause, Play } from 'lucide-react'
import { FaceLandmarker, FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision'
import { fetchFile, toBlobURL } from '@ffmpeg/util'
import type { CaptionResult, MotionTextLayer, MotionWord } from '@/lib/captions'
import CreativeRuntimeInspector from '@/components/creative-runtime-inspector'

type CaptionedVideoPreviewProps = { src: string; edit: CaptionResult }

const MAX_PREVIEW_WIDTH = 1280
const fontStacks = {
  sans: 'Arial, Helvetica, sans-serif',
  condensed: '"Barlow Condensed", "Arial Narrow Bold", Impact, sans-serif',
  monument: 'Anton, Impact, Haettenschweiler, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: '"Courier New", monospace',
  rounded: 'Trebuchet MS, Arial, sans-serif',
} satisfies Record<MotionWord['fontFamily'], string>

function drawMotionLayer(context: CanvasRenderingContext2D, layer: MotionTextLayer, time: number, width: number, height: number) {
  if (time < layer.start || time >= layer.end) return
  const elapsed = Math.max(0, Math.min(1, (time - layer.start) / 0.16))
  const activeWord = layer.kind === 'caption' ? layer.words.find((word) => time >= word.start && time < word.end) : undefined
  const entryDuration = layer.motion === 'impact' ? 0.22 : layer.motion === 'monument-rise' ? 0.28 : layer.motion === 'hero-expansion' ? 0.35 : 0.16
  const entryProgress = Math.max(0, Math.min(1, (time - layer.start) / entryDuration))
  const easedEntryProgress = 1 - (1 - entryProgress) ** 3
  const exitProgress = Math.max(0, Math.min(1, (layer.end - time) / (layer.motion === 'hero-expansion' ? 0.18 : 0.12)))
  let scaleFactor = 1
  const fontSize = (word: MotionWord) => Math.max(14, Math.min(height * 0.34, height * word.fontScale * scaleFactor))
  const font = (word: MotionWord) => `${word.italic ? 'italic ' : ''}${word.fontWeight} ${fontSize(word)}px ${fontStacks[word.fontFamily]}`
  const gap = height * 0.012
  const maxWidth = width * Math.min(layer.width, 0.94)
  type TextLine = { words: { word: MotionWord; width: number; active: boolean }[]; width: number; height: number }
  const buildLines = () => {
    const lines: TextLine[] = []
    let line: TextLine = { words: [], width: 0, height: 0 }
    for (const word of layer.words) {
      context.font = font(word)
      const label = word.uppercase ? word.text.toLocaleUpperCase() : word.text
      const wordWidth = context.measureText(label).width
      if (line.words.length && line.width + gap + wordWidth > maxWidth) {
        lines.push(line)
        line = { words: [], width: 0, height: 0 }
      }
      const nextGap = line.words.length ? gap : 0
      line.words.push({ word: { ...word, text: label }, width: wordWidth, active: word === activeWord })
      line.width += nextGap + wordWidth
      line.height = Math.max(line.height, fontSize(word) * 1.16)
    }
    if (line.words.length) lines.push(line)
    return lines
  }
  let lines = buildLines()
  let totalHeight = lines.reduce((sum, item) => sum + item.height, 0)
  for (let attempt = 0; attempt < 10; attempt++) {
    const widestLine = Math.max(0, ...lines.map((item) => item.width))
    const scaleForWidth = widestLine > maxWidth ? maxWidth / widestLine : 1
    const scaleForHeight = totalHeight > height * 0.84 ? (height * 0.84) / totalHeight : 1
    const nextScale = scaleFactor * Math.min(scaleForWidth, scaleForHeight, 0.92)
    if (nextScale >= scaleFactor || nextScale <= 0.12) break
    scaleFactor = nextScale
    lines = buildLines()
    totalHeight = lines.reduce((sum, item) => sum + item.height, 0)
  }
  const animationY = layer.motion === 'monument-rise'
    ? (1 - easedEntryProgress) * 36 * (height / 1080)
    : layer.motion === 'rise' ? (1 - elapsed) * height * 0.035 : 0
  const animationX = layer.motion === 'slide' ? (1 - elapsed) * width * 0.07 : 0
  const impactProgress = layer.motion === 'impact' ? entryProgress : activeWord ? Math.max(0, Math.min(1, (time - activeWord.start) / 0.22)) : 1
  const impactScale = impactProgress < 0.65 ? 0.85 + 0.18 * (impactProgress / 0.65) : 1.03 - 0.03 * ((impactProgress - 0.65) / 0.35)
  const animationScale = layer.motion === 'impact' ? impactScale : layer.motion === 'hero-expansion' ? 0.9 + easedEntryProgress * 0.1 : layer.motion === 'pop' ? 0.92 + elapsed * 0.08 : 1
  const animationAlpha = layer.motion === 'monument-rise' || layer.motion === 'hero-expansion' ? easedEntryProgress * exitProgress : layer.motion === 'impact' ? Math.min(1, entryProgress * 5) * exitProgress : layer.motion === 'fade' ? elapsed * exitProgress : exitProgress
  const safeMargin = height * 0.025
  const anchorX = Math.max(maxWidth / 2 + safeMargin, Math.min(width - maxWidth / 2 - safeMargin, layer.x * width + animationX))
  const desiredAnchorY = layer.y * height + animationY
  const minAnchorY = totalHeight / 2 + safeMargin
  const maxAnchorY = height - totalHeight / 2 - safeMargin
  const anchorY = Math.max(minAnchorY, Math.min(maxAnchorY, desiredAnchorY))
  const boxLeft = anchorX - maxWidth / 2
  let cursorY = anchorY - totalHeight / 2

  context.save()
  context.globalAlpha = animationAlpha
  context.translate(anchorX, anchorY)
  context.scale(animationScale, animationScale)
  context.translate(-anchorX, -anchorY)

  if (layer.background !== 'none') {
    const paddingX = height * 0.018
    const paddingY = height * 0.009
    context.fillStyle = layer.background === 'pill' ? 'rgba(9, 13, 17, .76)' : 'rgba(210, 255, 56, .78)'
    for (const item of lines) {
      const x = layer.align === 'left' ? boxLeft : layer.align === 'right' ? boxLeft + maxWidth - item.width : anchorX - item.width / 2
      const radius = layer.background === 'pill' ? item.height * 0.28 : item.height * 0.08
      context.beginPath()
      context.roundRect(x - paddingX, cursorY - paddingY, item.width + paddingX * 2, item.height + paddingY * 2, radius)
      context.fill()
      cursorY += item.height
    }
    cursorY = anchorY - totalHeight / 2
  }

  context.textBaseline = 'middle'
  context.lineJoin = 'round'
  for (const item of lines) {
    let cursorX = layer.align === 'left' ? boxLeft : layer.align === 'right' ? boxLeft + maxWidth - item.width : anchorX - item.width / 2
    for (const entry of item.words) {
      const size = fontSize(entry.word)
      const pop = entry.active && layer.motion === 'pop' ? 1.08 : 1
      context.save()
      context.translate(cursorX + entry.width / 2, cursorY + item.height / 2)
      context.scale(pop, pop)
      context.font = font(entry.word)
      context.textAlign = 'center'
      context.strokeStyle = 'rgba(8, 10, 12, .76)'
      context.lineWidth = Math.max(1, size * 0.035)
      context.shadowColor = 'rgba(0, 0, 0, .42)'
      context.shadowBlur = size * 0.06
      context.shadowOffsetY = size * 0.02
      context.strokeText(entry.word.text, 0, 0)
      context.fillStyle = entry.word.color
      context.fillText(entry.word.text, 0, 0)
      context.restore()
      cursorX += entry.width + gap
    }
    cursorY += item.height
  }
  context.restore()
}

type FFmpegInstance = {
  load(config: { classWorkerURL: string; coreURL: string; wasmURL: string }): Promise<boolean>
  writeFile(path: string, data: Uint8Array): Promise<boolean>
  exec(args: string[]): Promise<number>
  readFile(path: string): Promise<Uint8Array | string>
  deleteFile(path: string): Promise<boolean>
  terminate(): void
}

type FFmpegGlobal = { FFmpeg: new () => FFmpegInstance }

function loadFFmpegLibrary() {
  return new Promise<FFmpegGlobal['FFmpeg']>((resolve, reject) => {
    const scope = window as Window & { FFmpegWASM?: FFmpegGlobal }
    if (scope.FFmpegWASM?.FFmpeg) { resolve(scope.FFmpegWASM.FFmpeg); return }
    const script = document.createElement('script')
    script.src = 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/umd/ffmpeg.js'
    script.onload = () => scope.FFmpegWASM?.FFmpeg ? resolve(scope.FFmpegWASM.FFmpeg) : reject(new Error('Could not load the MP4 encoder.'))
    script.onerror = () => reject(new Error('Could not load the MP4 encoder. Check your connection and try again.'))
    document.head.appendChild(script)
  })
}

function activeCue<T extends { start: number; end: number }>(cues: T[], time: number) {
  return cues.find((cue) => time >= cue.start && time < cue.end)
}

export default function CaptionedVideoPreview({ src, edit }: CaptionedVideoPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [ready, setReady] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const frameRef = useRef<HTMLDivElement>(null)
  const [exporting, setExporting] = useState(false)
  const [exportMessage, setExportMessage] = useState('')
  const [currentTime, setCurrentTime] = useState(0)
  const [workingEdit, setWorkingEdit] = useState(edit)
  const editRef = useRef(edit)
  const lastUiUpdate = useRef(0)

  useEffect(() => {
    setWorkingEdit(edit)
  }, [edit])

  useEffect(() => {
    editRef.current = workingEdit
  }, [workingEdit])
  const [visualStatus, setVisualStatus] = useState<'loading' | 'ready' | 'fallback'>('loading')
  const foregroundRef = useRef<HTMLCanvasElement | null>(null)
  const faceBoxRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null)
  const lastSegmentAt = useRef(0)
  const lastSegmentVideoTime = useRef(-1)

  useEffect(() => {
    const onFullscreenChange = () => setIsFullscreen(document.fullscreenElement === frameRef.current)
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])

  const togglePlayback = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) void video.play()
    else video.pause()
  }, [])

  async function toggleFullscreen() {
    const frame = frameRef.current
    if (!frame) return
    try {
      if (document.fullscreenElement === frame) await document.exitFullscreen()
      else await frame.requestFullscreen()
    } catch {
      setExportMessage('Full-screen viewing is not available in this browser.')
    }
  }

  useEffect(() => {
    let cancelled = false
    let frame = 0
    let segmentBusy = false
    let segmenter: ImageSegmenter | null = null
    let faceLandmarker: FaceLandmarker | null = null
    const segmentationFrame = document.createElement('canvas')
    const video = videoRef.current
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!video || !canvas || !context) return

    const loadVision = async () => {
      try {
        const vision = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/wasm')
        const [nextSegmenter, nextFace] = await Promise.all([
          ImageSegmenter.createFromOptions(vision, {
            baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite' },
            runningMode: 'VIDEO',
            outputConfidenceMasks: true,
          }),
          FaceLandmarker.createFromOptions(vision, {
            baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task' },
            runningMode: 'VIDEO',
            numFaces: 1,
          }),
        ])
        if (cancelled) { nextSegmenter.close(); nextFace.close(); return }
        segmenter = nextSegmenter
        faceLandmarker = nextFace
        setVisualStatus('ready')
      } catch {
        setVisualStatus('fallback')
      }
    }
    void loadVision()

    const draw = (now: number) => {
      frame = requestAnimationFrame(draw)
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) return
      const activeEdit = editRef.current
      const scale = Math.min(1, MAX_PREVIEW_WIDTH / video.videoWidth)
      const width = Math.max(1, Math.round(video.videoWidth * scale))
      const height = Math.max(1, Math.round(video.videoHeight * scale))
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height }
      const time = video.currentTime
      const zoom = activeCue(activeEdit.zooms, time)
      const face = faceBoxRef.current
      const pivotX = face ? (face.x + face.width / 2) * width : width / 2
      const pivotY = face ? (face.y + face.height / 2) * height : height / 2
      const easedScale = zoom ? 1 + (zoom.scale - 1) * Math.min(1, (time - zoom.start) / 0.2, (zoom.end - time) / 0.25) : 1
      context.save()
      context.translate(pivotX, pivotY)
      context.scale(Math.max(1, easedScale), Math.max(1, easedScale))
      context.translate(-pivotX, -pivotY)
      context.drawImage(video, 0, 0, width, height)
      context.restore()

      if (segmenter && faceLandmarker && (!video.paused || time !== lastSegmentVideoTime.current) && !segmentBusy && now - lastSegmentAt.current > 110) {
        segmentBusy = true
        lastSegmentAt.current = now
        lastSegmentVideoTime.current = time
        try {
          const timestamp = Math.max(0, Math.round(now))
          if (segmentationFrame.width !== video.videoWidth || segmentationFrame.height !== video.videoHeight) {
            segmentationFrame.width = video.videoWidth
            segmentationFrame.height = video.videoHeight
          }
          segmentationFrame.getContext('2d')?.drawImage(video, 0, 0, segmentationFrame.width, segmentationFrame.height)
          const faceResult = faceLandmarker.detectForVideo(segmentationFrame, timestamp)
          const landmarks = faceResult.faceLandmarks[0]
          if (landmarks?.length) {
            const xs = landmarks.map((point) => point.x), ys = landmarks.map((point) => point.y)
            const x = Math.min(...xs), y = Math.min(...ys)
            const nextFace = { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
            const previousFace = faceBoxRef.current
            faceBoxRef.current = previousFace ? {
              x: previousFace.x + (nextFace.x - previousFace.x) * 0.38,
              y: previousFace.y + (nextFace.y - previousFace.y) * 0.38,
              width: previousFace.width + (nextFace.width - previousFace.width) * 0.38,
              height: previousFace.height + (nextFace.height - previousFace.height) * 0.38,
            } : nextFace
          }
          segmenter.segmentForVideo(segmentationFrame, timestamp, (result) => {
            const masks = result.confidenceMasks
            if (!masks?.length) { foregroundRef.current = null; segmentBusy = false; return }
            const face = faceBoxRef.current
            const faceX = Math.min(masks[0].width - 1, Math.max(0, Math.round(((face?.x ?? 0.5) + (face?.width ?? 0) / 2) * masks[0].width)))
            const faceY = Math.min(masks[0].height - 1, Math.max(0, Math.round(((face?.y ?? 0.3) + (face?.height ?? 0) / 2) * masks[0].height)))
            const facePixel = faceY * masks[0].width + faceX
            let maskIndex = 0
            let faceConfidence = -1
            masks.forEach((candidate, index) => {
              const confidence = candidate.getAsFloat32Array()[facePixel]
              if (confidence > faceConfidence) { faceConfidence = confidence; maskIndex = index }
            })
            const mask = masks[maskIndex]
            masks.forEach((candidate, index) => { if (index !== maskIndex) candidate.close() })
            const maskWidth = mask.width, maskHeight = mask.height
            const values = mask.getAsFloat32Array()
            const maskCanvas = document.createElement('canvas')
            maskCanvas.width = maskWidth; maskCanvas.height = maskHeight
            const maskContext = maskCanvas.getContext('2d')
            if (maskContext) {
              const pixels = maskContext.createImageData(maskWidth, maskHeight)
              let foreground = 0
              for (let i = 0; i < values.length; i++) {
                const alpha = Math.max(0, Math.min(255, Math.round((values[i] - 0.38) * 410)))
                pixels.data[i * 4] = 255; pixels.data[i * 4 + 1] = 255; pixels.data[i * 4 + 2] = 255; pixels.data[i * 4 + 3] = alpha
                if (alpha > 128) foreground++
              }
              if (foreground / values.length > 0.035 && foreground / values.length < 0.88) {
                maskContext.putImageData(pixels, 0, 0)
                const subject = document.createElement('canvas')
                subject.width = width; subject.height = height
                const subjectContext = subject.getContext('2d')
                if (subjectContext) {
                  subjectContext.drawImage(segmentationFrame, 0, 0, width, height)
                  subjectContext.globalCompositeOperation = 'destination-in'
                  subjectContext.drawImage(maskCanvas, 0, 0, width, height)
                  foregroundRef.current = subject
                }
              } else foregroundRef.current = null
            }
            mask.close()
            segmentBusy = false
          })
        } catch {
          segmentBusy = false
          foregroundRef.current = null
        }
      }

      const maskAvailable = Boolean(foregroundRef.current)
      const behindLayers = activeEdit.layers.filter((layer) => layer.depth === 'behind-subject' && maskAvailable)
      const foregroundLayers = activeEdit.layers.filter((layer) => !behindLayers.includes(layer))

      if (behindLayers.length && foregroundRef.current) {
        context.save()
        context.filter = `blur(${Math.max(5, height * 0.008)}px)`
        context.translate(pivotX, pivotY)
        context.scale(Math.max(1, easedScale), Math.max(1, easedScale))
        context.translate(-pivotX, -pivotY)
        context.drawImage(video, 0, 0, width, height)
        context.restore()
      }

      behindLayers.forEach((layer) => drawMotionLayer(context, layer, time, width, height))

      if (behindLayers.length && foregroundRef.current) {
        context.save()
        context.translate(pivotX, pivotY)
        context.scale(Math.max(1, easedScale), Math.max(1, easedScale))
        context.translate(-pivotX, -pivotY)
        context.drawImage(foregroundRef.current, 0, 0, width, height)
        context.restore()
      }

      foregroundLayers.forEach((layer) => drawMotionLayer(context, layer, time, width, height))

      context.save()
      context.font = `500 ${Math.max(10, height * 0.014)}px Inter, Arial, sans-serif`
      context.textAlign = 'right'
      context.textBaseline = 'bottom'
      context.fillStyle = 'rgba(255, 245, 231, .82)'
      context.shadowColor = 'rgba(0, 0, 0, .48)'
      context.shadowBlur = 3
      context.fillText('SHORTSAGENTS / MONUMENT 01', width * 0.965, height * 0.955, width * 0.56)
      context.restore()

      if (now - lastUiUpdate.current > 120) {
        lastUiUpdate.current = now
        setCurrentTime(time)
      }
    }

    const onMetadata = () => setReady(true)
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    video.addEventListener('loadedmetadata', onMetadata)
    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    video.addEventListener('ended', onPause)
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) onMetadata()
    frame = requestAnimationFrame(draw)
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      video.removeEventListener('loadedmetadata', onMetadata)
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('ended', onPause)
      segmenter?.close()
      faceLandmarker?.close()
    }
  }, [])

  async function exportVideo() {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas || exporting) return
    if (!canvas.captureStream || typeof MediaRecorder === 'undefined') {
      setExportMessage('Video export is not supported in this browser. Try the latest Chrome or Edge.')
      return
    }
    setExporting(true)
    setExportMessage('Rendering your edited video…')
    const previousTime = video.currentTime
    const wasPlaying = !video.paused
    let ffmpeg: FFmpegInstance | null = null
    try {
      video.pause()
      if (video.currentTime !== 0) {
        video.currentTime = 0
        await new Promise<void>((resolve) => video.addEventListener('seeked', () => resolve(), { once: true }))
      }
      const stream = canvas.captureStream(30)
      const videoStream = (video as HTMLVideoElement & { captureStream?: () => MediaStream }).captureStream?.()
      if (!videoStream?.getAudioTracks().length) throw new Error('This browser cannot include the video audio in an export. Try the latest Chrome or Edge.')
      videoStream.getAudioTracks().forEach((track) => stream.addTrack(track))
      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') ? 'video/webm;codecs=vp9,opus' : 'video/webm'
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4_000_000 })
      const chunks: BlobPart[] = []
      const finished = new Promise<Blob>((resolve, reject) => {
        recorder.addEventListener('dataavailable', (event) => { if (event.data.size) chunks.push(event.data) })
        recorder.addEventListener('stop', () => resolve(new Blob(chunks, { type: mimeType })), { once: true })
        recorder.addEventListener('error', () => reject(new Error('The video render failed. Please try again.')), { once: true })
      })
      recorder.start(250)
      await video.play()
      await new Promise<void>((resolve) => video.addEventListener('ended', () => resolve(), { once: true }))
      recorder.stop()
      const webm = await finished
      setExportMessage('Converting your edit to MP4…')
      const FFmpeg = await loadFFmpegLibrary()
      ffmpeg = new FFmpeg()
      const coreBase = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd'
      const workerUrl = `${window.location.origin}/ffmpeg/worker.js`
      await ffmpeg.load({
        classWorkerURL: workerUrl,
        coreURL: await toBlobURL(`${coreBase}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${coreBase}/ffmpeg-core.wasm`, 'application/wasm'),
      })
      await ffmpeg.writeFile('edit.webm', await fetchFile(webm))
      const conversion = await ffmpeg.exec(['-i', 'edit.webm', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', 'edit.mp4'])
      if (conversion !== 0) throw new Error('MP4 conversion failed. Please try exporting again in Chrome or Edge.')
      const mp4Data = await ffmpeg.readFile('edit.mp4')
      const mp4 = new Blob([mp4Data as Uint8Array<ArrayBuffer>], { type: 'video/mp4' })
      await ffmpeg.deleteFile('edit.webm')
      await ffmpeg.deleteFile('edit.mp4')
      const link = document.createElement('a')
      link.href = URL.createObjectURL(mp4)
      link.download = 'vocal-ai-edit.mp4'
      link.click()
      setTimeout(() => URL.revokeObjectURL(link.href), 60_000)
      setExportMessage('MP4 export downloaded.')
    } catch (error) {
      setExportMessage(error instanceof Error ? error.message : 'Could not export this video.')
    } finally {
      ffmpeg?.terminate()
      video.pause()
      video.currentTime = Math.min(previousTime, video.duration || previousTime)
      if (wasPlaying) void video.play()
      setExporting(false)
    }
  }

  const activeLayer = activeCue(workingEdit.layers, currentTime)
  const activeSpokenWord = workingEdit.layers.find((layer) => layer.kind === 'caption' && layer.words.some((word) => currentTime >= word.start && currentTime < word.end))?.words.find((word) => currentTime >= word.start && currentTime < word.end)
  const [selectedLayerId, setSelectedLayerId] = useState(edit.layers[0]?.id ?? '')

  function updateLayer(layerId: string, update: (layer: MotionTextLayer) => MotionTextLayer) {
    setWorkingEdit((current) => ({ ...current, layers: current.layers.map((layer) => layer.id === layerId ? update(layer) : layer) }))
  }

  function updateZoom(index: number, scale: number) {
    setWorkingEdit((current) => ({ ...current, zooms: current.zooms.map((zoom, zoomIndex) => zoomIndex === index ? { ...zoom, scale } : zoom) }))
  }

  return (
    <section className="video-preview-card" aria-label="AI-edited video preview">
      <div ref={frameRef} className={`video-frame${isFullscreen ? ' is-fullscreen' : ''}`} style={ready ? { aspectRatio: `${videoRef.current?.videoWidth || 16} / ${videoRef.current?.videoHeight || 9}` } : undefined}>
        <video ref={videoRef} className="caption-preview-video" src={src} playsInline preload="metadata" aria-label="Source video for the AI edit" />
        <canvas ref={canvasRef} className="creator-render-canvas" aria-label="Rendered AI-edited video" />
        <div className="render-controls">
          <button type="button" className="render-control" onClick={togglePlayback} aria-label={playing ? 'Pause edited video' : 'Play edited video'}>
            {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
          </button>
          <input aria-label="Video playback position" type="range" min="0" max={videoRef.current?.duration || 1} step="0.05" value={currentTime} onChange={(event) => { if (videoRef.current) videoRef.current.currentTime = Number(event.target.value) }} />
          <span>{Math.floor(currentTime / 60)}:{String(Math.floor(currentTime % 60)).padStart(2, '0')}</span>
          <button type="button" className="render-control fullscreen-control" onClick={toggleFullscreen} aria-label={isFullscreen ? 'Exit full screen' : 'View full screen'} title={isFullscreen ? 'Exit full screen' : 'View full screen'}>
            {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
        </div>
      </div>
      <div className="preview-footer">
        <span className={`vision-status vision-status-${visualStatus}`}><i />{visualStatus === 'ready' ? 'Subject tracking active' : visualStatus === 'loading' ? 'Loading subject tracking…' : 'Using clean text placement'}</span>
        <button type="button" className="export-button" onClick={exportVideo} disabled={!ready || exporting}><Download size={15} />{exporting ? 'Rendering…' : 'Download video'}</button>
      </div>
      <CreativeRuntimeInspector edit={workingEdit} currentTime={currentTime} selectedLayerId={selectedLayerId} onSelectLayer={setSelectedLayerId} onUpdateLayer={updateLayer} onUpdateZoom={updateZoom} onSeek={(time) => { if (videoRef.current) videoRef.current.currentTime = time }} />
      {activeSpokenWord && <p className="sr-only" aria-live="polite">Caption: {activeSpokenWord.text}</p>}
      {activeLayer?.kind === 'headline' && <p className="sr-only" aria-live="polite">Headline: {activeLayer.words.map((word) => word.text).join(' ')}</p>}
      <p className="caption-preview-note">The Creative Runtime composes editable text layers from your transcript, then renders the same scene graph for preview and export.</p>
      {exportMessage && <p className="export-message" role="status">{exportMessage}</p>}
    </section>
  )
}
