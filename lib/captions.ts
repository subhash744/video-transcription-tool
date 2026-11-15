import { z } from 'zod'

export const CaptionUnitSchema = z.object({
  text: z.string().trim().min(1).max(1_000),
  start: z.number().finite().min(0),
  end: z.number().finite().positive(),
  kind: z.enum(['word', 'phrase']),
}).refine((unit) => unit.end > unit.start && unit.end <= 130, 'Caption timing is outside the supported video duration')

export type CaptionUnit = z.infer<typeof CaptionUnitSchema>

const WordStyleSchema = z.object({
  unitIndex: z.number().int().nonnegative(),
  fontFamily: z.enum(['sans', 'condensed', 'serif', 'mono', 'rounded']).nullable(),
  fontScale: z.number().min(0.65).max(2.5).nullable(),
  fontWeight: z.number().int().min(400).max(900).nullable(),
  color: z.string().regex(/^#[\da-fA-F]{6}$/).nullable(),
  italic: z.boolean().nullable(),
  uppercase: z.boolean().nullable(),
})

const CreativeLayerSchema = z.object({
  kind: z.enum(['caption', 'headline']),
  unitIndexes: z.array(z.number().int().nonnegative()).min(1).max(12),
  text: z.string().trim().max(60).nullable(),
  x: z.number().min(0.05).max(0.95),
  y: z.number().min(0.05).max(0.95),
  width: z.number().min(0.2).max(0.96),
  align: z.enum(['left', 'center', 'right']),
  depth: z.enum(['foreground', 'behind-subject']),
  fontFamily: z.enum(['sans', 'condensed', 'monument', 'serif', 'mono', 'rounded']),
  fontScale: z.number().min(0.025).max(0.22),
  fontWeight: z.number().int().min(400).max(900),
  color: z.string().regex(/^#[\da-fA-F]{6}$/),
  italic: z.boolean(),
  uppercase: z.boolean(),
  background: z.enum(['none', 'pill', 'marker']),
  motion: z.enum(['none', 'fade', 'rise', 'pop', 'slide', 'impact', 'monument-rise', 'hard-cut', 'hero-expansion']),
  wordStyles: z.array(WordStyleSchema).max(12),
})

export const ZoomPlanSchema = z.object({
  unitIndexes: z.array(z.number().int().nonnegative()).min(1).max(8),
  scale: z.number().min(1.04).max(1.1),
})

const CaptionPlanAnalysisSchema = z.object({
  visualObservations: z.array(z.object({ frameTime: z.number().min(0), observation: z.string().trim().min(1).max(500) })).max(60),
  interpretations: z.array(z.object({ frameTime: z.number().min(0).nullable(), interpretation: z.string().trim().min(1).max(500), uncertainty: z.string().trim().min(1).max(300) })).max(60),
  transcriptUnderstanding: z.string().trim().min(1).max(2_000),
  importantMoments: z.array(z.object({ unitIndexes: z.array(z.number().int().nonnegative()).min(1).max(8), rationale: z.string().trim().min(1).max(500) })).max(30),
  creativeRationales: z.array(z.object({ unitIndexes: z.array(z.number().int().nonnegative()).min(1).max(12), decision: z.enum(['caption', 'headline', 'motion', 'zoom', 'depth']), selectedValue: z.string().trim().min(1).max(100), rationale: z.string().trim().min(1).max(500) })).max(180),
})

export const CaptionPlanSchema = z.object({
  layers: z.array(CreativeLayerSchema).max(180),
  zooms: z.array(ZoomPlanSchema).max(8),
  analysis: CaptionPlanAnalysisSchema,
})

export const VisualFrameSchema = z.object({
  time: z.number().finite().min(0).max(120),
  image: z.string().regex(/^data:image\/(jpeg|webp);base64,/).max(400_000),
  subject: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().min(0).max(1), height: z.number().min(0).max(1) }).nullable(),
  head: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().min(0).max(1), height: z.number().min(0).max(1) }).nullable(),
})

export const CaptionRequestSchema = z.object({
  transcript: z.string().trim().min(1).max(20_000),
  units: z.array(CaptionUnitSchema).min(1).max(1_800),
  duration: z.number().finite().positive().max(120),
  visualFrames: z.array(VisualFrameSchema).min(1).max(60),
  style: z.literal('monument'),
}).refine((request) => request.units.every((unit) => unit.end <= request.duration + 0.5), 'Speech timing extends beyond the uploaded video')

export type TextFont = 'sans' | 'condensed' | 'monument' | 'serif' | 'mono' | 'rounded'
export type TextMotion = 'none' | 'fade' | 'rise' | 'pop' | 'slide' | 'impact' | 'monument-rise' | 'hard-cut' | 'hero-expansion'
export type MotionWord = {
  text: string
  start: number
  end: number
  fontFamily: TextFont
  fontScale: number
  fontWeight: number
  color: string
  italic: boolean
  uppercase: boolean
}
export type MotionTextLayer = {
  id: string
  kind: 'caption' | 'headline'
  start: number
  end: number
  words: MotionWord[]
  x: number
  y: number
  width: number
  align: 'left' | 'center' | 'right'
  depth: 'foreground' | 'behind-subject'
  fontFamily: TextFont
  fontScale: number
  fontWeight: number
  color: string
  italic: boolean
  uppercase: boolean
  background: 'none' | 'pill' | 'marker'
  motion: TextMotion
}
export type ZoomCue = { start: number; end: number; scale: number }
export type CaptionPlan = z.infer<typeof CaptionPlanSchema>
export type PipelineStage = 'video-input' | 'audio-extraction' | 'transcription' | 'frame-extraction' | 'subject-detection' | 'model-analysis' | 'scene-graph-validation' | 'preview-render' | 'video-export'
export type DebugValue = string | number | boolean | null | DebugValue[] | { [key: string]: DebugValue }
export type PipelineEvent = {
  id: string
  at: string
  stage: PipelineStage
  status: 'started' | 'progress' | 'completed' | 'modified' | 'failed' | 'fallback' | 'warning'
  message: string
  videoTime?: number
  details?: Record<string, DebugValue>
}
export type CaptionDebugData = {
  model: { name: string; durationMs: number; originalOutput: CaptionPlan }
  finalSceneGraph: { layers: MotionTextLayer[]; zooms: ZoomCue[] }
  normalizations: PipelineEvent[]
}
export type CaptionResult = {
  layers: MotionTextLayer[]
  zooms: ZoomCue[]
  timingPrecision: 'word' | 'phrase'
  segmentationAvailable: boolean
  style: 'monument'
  debug: CaptionDebugData
}
