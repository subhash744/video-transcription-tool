'use client'

import { FaceLandmarker, FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision'
import type { VisualFrameSchema } from '@/lib/captions'
import { z } from 'zod'

export type VisualFrame = z.infer<typeof VisualFrameSchema>

function seek(video: HTMLVideoElement, time: number) {
  return new Promise<void>((resolve, reject) => {
    const onSeeked = () => { cleanup(); resolve() }
    const onError = () => { cleanup(); reject(new Error('Could not analyze this video frame.')) }
    const cleanup = () => {
      video.removeEventListener('seeked', onSeeked)
      video.removeEventListener('error', onError)
    }
    video.addEventListener('seeked', onSeeked, { once: true })
    video.addEventListener('error', onError, { once: true })
    video.currentTime = time
  })
}

export type VideoAnalysisProgress = {
  stage: 'frame-extraction' | 'subject-detection'
  status: 'started' | 'progress' | 'completed' | 'fallback'
  frameIndex?: number
  frameCount?: number
  videoTime?: number
  message: string
}
export type VideoAnalysisResult = { frames: VisualFrame[]; detectionMode: 'mediapipe' | 'frames-only'; detectionError?: string }

export async function analyzeVideoFrames(file: File, onProgress?: (progress: VideoAnalysisProgress) => void): Promise<VideoAnalysisResult> {
  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  video.src = url
  let segmenter: ImageSegmenter | null = null
  let faceLandmarker: FaceLandmarker | null = null
  let fallbackReason: string | undefined

  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve()
      video.onerror = () => reject(new Error('Could not read the video for visual analysis.'))
    })

    const maxDimension = 384
    const scale = Math.min(1, maxDimension / Math.max(video.videoWidth, video.videoHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('This browser cannot analyze video frames.')
    const sampleTimes = Array.from({ length: Math.min(60, Math.ceil(video.duration / 2)) }, (_, index) => Math.min(video.duration - 0.05, 0.15 + index * 2))
    let detectionReady = false

    try {
      onProgress?.({ stage: 'subject-detection', status: 'started', message: 'Loading face and person segmentation models.' })
      const vision = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/wasm')
      ;[segmenter, faceLandmarker] = await Promise.all([
        ImageSegmenter.createFromOptions(vision, {
          baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite' },
          runningMode: 'IMAGE', outputConfidenceMasks: true,
        }),
        FaceLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task' },
          runningMode: 'IMAGE', numFaces: 1,
        }),
      ])
      detectionReady = true
      onProgress?.({ stage: 'subject-detection', status: 'progress', message: 'Face and person segmentation models are ready.' })
    } catch (error) {
      fallbackReason = error instanceof Error ? error.message : 'Vision models could not be initialized.'
      onProgress?.({ stage: 'subject-detection', status: 'fallback', message: `Detection unavailable: ${fallbackReason}` })
    }

    onProgress?.({ stage: 'frame-extraction', status: 'started', frameCount: sampleTimes.length, message: `Extracting ${sampleTimes.length} sampled frames.` })
    const frames: VisualFrame[] = []
    for (const [index, time] of sampleTimes.entries()) {
      await seek(video, time)
      context.drawImage(video, 0, 0, canvas.width, canvas.height)
      let head: VisualFrame['head'] = null
      let subject: VisualFrame['subject'] = null
      if (detectionReady && segmenter && faceLandmarker) {
        const face = faceLandmarker.detect(canvas).faceLandmarks[0]
        if (face?.length) {
          const clamp = (value: number) => Math.max(0, Math.min(1, value))
          const xs = face.map((point) => clamp(point.x)), ys = face.map((point) => clamp(point.y))
          const x = Math.min(...xs), y = Math.min(...ys)
          head = { x, y, width: Math.min(1 - x, Math.max(...xs) - x), height: Math.min(1 - y, Math.max(...ys) - y) }
        }
        segmenter.segment(canvas, (result) => {
          const mask = result.confidenceMasks?.[0]
          if (!mask) return
          const probabilities = mask.getAsFloat32Array()
          const step = Math.max(1, Math.floor(probabilities.length / 12000))
          let minX = 1, minY = 1, maxX = 0, maxY = 0, included = 0
          for (let i = 0; i < probabilities.length; i += step) {
            if (probabilities[i] < 0.55) continue
            const x = (i % mask.width) / mask.width, y = Math.floor(i / mask.width) / mask.height
            minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); included++
          }
          const coverage = included / Math.ceil(probabilities.length / step)
          if (coverage > 0.035 && coverage < 0.85 && maxX > minX && maxY > minY) subject = { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
          mask.close()
        })
      }
      frames.push({ time, image: canvas.toDataURL('image/jpeg', 0.62), head, subject })
      onProgress?.({ stage: 'frame-extraction', status: 'progress', frameIndex: index + 1, frameCount: sampleTimes.length, videoTime: time, message: `Captured sampled frame ${index + 1} of ${sampleTimes.length}.` })
      if (detectionReady) onProgress?.({ stage: 'subject-detection', status: 'progress', frameIndex: index + 1, frameCount: sampleTimes.length, videoTime: time, message: head || subject ? 'Face/person boundaries recorded.' : 'No face or person boundary detected in this sample.' })
    }
    onProgress?.({ stage: 'frame-extraction', status: 'completed', frameCount: frames.length, message: `Captured ${frames.length} sampled frames.` })
    if (detectionReady) onProgress?.({ stage: 'subject-detection', status: fallbackReason ? 'fallback' : 'completed', frameCount: frames.length, message: `${frames.filter((frame) => frame.subject).length} subject and ${frames.filter((frame) => frame.head).length} face boundaries detected across ${frames.length} frames.` })
    return { frames, detectionMode: detectionReady ? 'mediapipe' : 'frames-only', ...(fallbackReason ? { detectionError: fallbackReason } : {}) }
  } finally {
    segmenter?.close()
    faceLandmarker?.close()
    video.pause()
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
}
