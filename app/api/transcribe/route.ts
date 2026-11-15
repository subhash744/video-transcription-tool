import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const maxDuration = 150

const MAX_AUDIO_BYTES = 25 * 1024 * 1024

export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'OpenAI is not configured for this app yet. Add OPENAI_API_KEY in the project environment settings.' }, { status: 503 })
  }

  try {
    const form = await request.formData()
    const audio = form.get('audio')

    if (!(audio instanceof File) || !audio.size) {
      return NextResponse.json({ error: 'Please add a video with an audio track.' }, { status: 400 })
    }
    if (audio.size > MAX_AUDIO_BYTES) {
      return NextResponse.json({ error: 'The audio is too large to transcribe. Try a shorter or smaller video.' }, { status: 413 })
    }

    const openAiForm = new FormData()
    openAiForm.append('file', audio, 'video-audio.webm')
    openAiForm.append('model', 'whisper-1')
    openAiForm.append('response_format', 'verbose_json')
    openAiForm.append('timestamp_granularities[]', 'word')
    openAiForm.append('timestamp_granularities[]', 'segment')

    const transcriptionStartedAt = Date.now()
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: openAiForm,
      signal: AbortSignal.timeout(120_000),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) {
      const message = typeof result?.error?.message === 'string' ? result.error.message : 'OpenAI could not transcribe this video. Check the project API key and try again.'
      return NextResponse.json({ error: message }, { status: response.status === 401 ? 401 : 502 })
    }
    const words = Array.isArray(result.words) ? result.words : []
    const segments = Array.isArray(result.segments) ? result.segments : []
    const wordUnits = words.flatMap((word: { word?: unknown; start?: unknown; end?: unknown }) => {
      const text = typeof word.word === 'string' ? word.word.trim() : ''
      const start = Number(word.start)
      const end = Number(word.end)
      return text && Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start
        ? [{ text, start, end, kind: 'word' as const }]
        : []
    })
    const phraseUnits = segments.flatMap((segment: { text?: unknown; start?: unknown; end?: unknown }) => {
      const text = typeof segment.text === 'string' ? segment.text.trim() : ''
      const start = Number(segment.start)
      const end = Number(segment.end)
      return text && Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start
        ? [{ text, start, end, kind: 'phrase' as const }]
        : []
    })
    const units = wordUnits.length ? wordUnits : phraseUnits
    return NextResponse.json({
      text: typeof result.text === 'string' ? result.text : '',
      units,
      diagnostics: {
        model: 'whisper-1',
        responseFormat: 'verbose_json',
        requestedTimingGranularities: ['word', 'segment'],
        audioBytes: audio.size,
        unitCount: units.length,
        timingPrecision: wordUnits.length ? 'word' : 'phrase',
        durationMs: Date.now() - transcriptionStartedAt,
      },
    })
  } catch (error) {
    const message = error instanceof Error && error.name === 'TimeoutError'
      ? 'Transcription took too long. Please try again.'
      : 'We couldn’t reach OpenAI. Check your connection and try again.'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
