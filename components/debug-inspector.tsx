'use client'

import { useState } from 'react'
import { Download, ScanLine } from 'lucide-react'
import type { CaptionResult, CaptionUnit, PipelineEvent } from '@/lib/captions'
import type { VisualFrame } from '@/lib/video-analysis'

type VideoMetadata = { mimeType: string; fileBytes: number; durationSeconds: number; transcription?: { model: string; responseFormat: string; requestedTimingGranularities: string[]; audioBytes: number; unitCount: number; timingPrecision: 'word' | 'phrase'; durationMs: number } }
type DebugInspectorProps = {
  edit: CaptionResult
  pipelineEvents: PipelineEvent[]
  rendererEvents: PipelineEvent[]
  visualFrames: VisualFrame[]
  transcript: string
  units: CaptionUnit[]
  videoMetadata: VideoMetadata
  onSeek: (time: number) => void
}

const statusLabels: Record<PipelineEvent['status'], string> = {
  started: 'Started', progress: 'Progress', completed: 'Completed', modified: 'Modified', failed: 'Failed', fallback: 'Fallback', warning: 'Warning',
}
const safeString = (value: string) => value.replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]').replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
const redactSensitiveStrings = (value: unknown): unknown => {
  if (typeof value === 'string') return safeString(value)
  if (Array.isArray(value)) return value.map(redactSensitiveStrings)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactSensitiveStrings(entry)]))
  return value
}

function downloadReport(report: unknown) {
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'monument-debug-report.json'
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

function formatTime(time: number) {
  const minutes = Math.floor(time / 60)
  return `${String(minutes).padStart(2, '0')}:${(time % 60).toFixed(2).padStart(5, '0')}`
}

export default function DebugInspector({ edit, pipelineEvents, rendererEvents, visualFrames, transcript, units, videoMetadata, onSeek }: DebugInspectorProps) {
  const [selectedEventId, setSelectedEventId] = useState('')
  const [showModelOutput, setShowModelOutput] = useState(false)
  const events = [...pipelineEvents, ...rendererEvents].sort((a, b) => a.at.localeCompare(b.at))
  const selectedEvent = events.find((event) => event.id === selectedEventId)
  const original = edit.debug?.model.originalOutput
  const backendFinalGraph = edit.debug?.finalSceneGraph ?? { layers: edit.layers, zooms: edit.zooms }
  const finalGraph = { layers: edit.layers, zooms: edit.zooms }
  const isSampledFrame = (time: number) => visualFrames.some((frame) => Math.abs(frame.time - time) <= 0.02)
  const hasValidUnitAnchors = (indexes: number[]) => indexes.length > 0 && indexes.every((unitIndex) => Number.isInteger(unitIndex) && unitIndex >= 0 && unitIndex < units.length)
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    input: {
      mimeType: videoMetadata.mimeType,
      fileBytes: videoMetadata.fileBytes,
      durationSeconds: videoMetadata.durationSeconds,
      transcript,
      timestampedUnits: units,
      transcription: videoMetadata.transcription ?? null,
      sampledFrames: visualFrames.map(({ time, subject, head }) => ({ time, subject, head })),
    },
    model: edit.debug?.model ? { name: edit.debug.model.name, durationMs: edit.debug.model.durationMs, originalOutput: edit.debug.model.originalOutput } : null,
    sceneGraph: { backendFinal: backendFinalGraph, currentRendererInput: finalGraph, normalizations: edit.debug?.normalizations ?? [] },
    events: events.map((event) => ({ ...event, message: safeString(event.message) })),
    privacy: { rawVideoFramesIncluded: false, credentialsIncluded: false },
  }

  return (
    <section className="debug-inspector" aria-labelledby="debug-inspector-title">
      <div className="debug-heading">
        <div><span className="debug-kicker">MONUMENT 01 · PIPELINE TRACE</span><h3 id="debug-inspector-title">Debug Inspector</h3><p>Observed inputs, model intent, engine behavior, and export outcomes.</p></div>
        <button className="debug-download" type="button" onClick={() => downloadReport(redactSensitiveStrings(report))}><Download size={14} /> Export JSON</button>
      </div>

      <div className="debug-summary" aria-label="Pipeline summary">
        <span><strong>{events.length}</strong> events</span><span><strong>{visualFrames.length}</strong> sampled frames</span><span><strong>{finalGraph.layers.length}</strong> final layers</span><span><strong>{finalGraph.zooms.length}</strong> zooms</span>
      </div>

      <div className="debug-grid">
        <div className="debug-events-panel">
          <div className="debug-section-title"><ScanLine size={14} /> LIVE PIPELINE EVENTS</div>
          {events.length ? <ol className="debug-event-list">
            {events.map((event) => <li key={event.id}>
              <button type="button" className={`debug-event debug-event-${event.status}${selectedEventId === event.id ? ' is-selected' : ''}`} onClick={() => { setSelectedEventId(event.id); if (event.videoTime !== undefined) onSeek(event.videoTime) }}>
                <span className="debug-event-dot" aria-hidden="true" /><span className="debug-event-copy"><strong>{event.stage.replaceAll('-', ' ')}</strong><small>{safeString(event.message)}</small></span><span className="debug-event-state">{statusLabels[event.status]}</span>{event.videoTime !== undefined && <time>{formatTime(event.videoTime)}</time>}
              </button>
            </li>)}
          </ol> : <p className="debug-empty">No pipeline events have been recorded.</p>}
          {selectedEvent && <div className="debug-selected-event"><strong>{selectedEvent.stage.replaceAll('-', ' ')} · {statusLabels[selectedEvent.status]}</strong><time>{new Date(selectedEvent.at).toLocaleTimeString()}{selectedEvent.videoTime !== undefined ? ` · video ${formatTime(selectedEvent.videoTime)}` : ''}</time>{selectedEvent.details && <pre>{JSON.stringify(selectedEvent.details, null, 2)}</pre>}</div>}
        </div>

        <div className="debug-frame-panel">
          <div className="debug-section-title">SAMPLED FRAMES & DETECTION BOUNDARIES</div>
          {visualFrames.length ? <div className="debug-frame-grid">{visualFrames.map((frame, index) => <button type="button" className="debug-frame" key={`${frame.time}-${index}`} onClick={() => onSeek(frame.time)} aria-label={`Seek to sampled frame at ${formatTime(frame.time)}`}>
            <span className="debug-frame-image"><img src={frame.image} alt={`Video frame sampled at ${formatTime(frame.time)}`} />{edit.layers.filter((layer) => frame.time >= layer.start && frame.time < layer.end).map((layer) => { const boxHeight = Math.max(layer.fontScale * 1.35, layer.kind === 'headline' ? 0.18 : 0.11); return <i key={layer.id} className="debug-box debug-caption-box" title={`${layer.kind} ${layer.id} · x ${Math.round(layer.x * 100)}%, y ${Math.round(layer.y * 100)}%`} style={{ left: `${(layer.x - layer.width / 2) * 100}%`, top: `${(layer.y - boxHeight / 2) * 100}%`, width: `${layer.width * 100}%`, height: `${boxHeight * 100}%` }} /> })}{frame.subject && <i className="debug-box debug-subject-box" style={{ left: `${frame.subject.x * 100}%`, top: `${frame.subject.y * 100}%`, width: `${frame.subject.width * 100}%`, height: `${frame.subject.height * 100}%` }} />}{frame.head && <i className="debug-box debug-face-box" style={{ left: `${frame.head.x * 100}%`, top: `${frame.head.y * 100}%`, width: `${frame.head.width * 100}%`, height: `${frame.head.height * 100}%` }} />}</span><span>{formatTime(frame.time)}</span>
          </button>)}</div> : <p className="debug-empty">No sampled frames were produced.</p>}
          <div className="debug-legend"><span><i className="debug-caption-box" /> Caption layout</span><span><i className="debug-subject-box" /> Subject boundary</span><span><i className="debug-face-box" /> Face boundary</span></div>
        </div>
      </div>

      {original && <div className="debug-analysis-grid">
        <section><div className="debug-section-title">DIRECT VISUAL OBSERVATIONS</div>{original.analysis.visualObservations.map((item, index) => <button className="debug-rationale" key={`${item.frameTime}-${index}`} type="button" disabled={!isSampledFrame(item.frameTime)} onClick={() => onSeek(item.frameTime)}><time>{formatTime(item.frameTime)}{isSampledFrame(item.frameTime) ? '' : ' · unmatched sample'}</time><span>{item.observation}</span></button>)}{!original.analysis.visualObservations.length && <p className="debug-empty">The model returned no direct visual observations.</p>}</section>
        <section><div className="debug-section-title">INTERPRETATIONS & UNCERTAINTY</div>{original.analysis.interpretations.map((item, index) => <button className="debug-rationale" key={`${item.frameTime}-${index}`} type="button" disabled={item.frameTime === null || !isSampledFrame(item.frameTime)} onClick={() => item.frameTime !== null && onSeek(item.frameTime)}><time>{item.frameTime === null ? 'No frame cited' : `${formatTime(item.frameTime)}${isSampledFrame(item.frameTime) ? '' : ' · unmatched sample'}`}</time><span><strong>{item.interpretation}</strong><small>Uncertainty: {item.uncertainty}</small></span></button>)}{!original.analysis.interpretations.length && <p className="debug-empty">The model returned no interpretations.</p>}</section>
        <section><div className="debug-section-title">TRANSCRIPT UNDERSTANDING</div><p className="debug-transcript-understanding">{original.analysis.transcriptUnderstanding}</p><div className="debug-section-title">IMPORTANT MOMENTS</div>{original.analysis.importantMoments.map((item, index) => <button className="debug-rationale" key={index} type="button" disabled={!hasValidUnitAnchors(item.unitIndexes)} onClick={() => { const unit = units[item.unitIndexes[0]]; if (unit) onSeek(unit.start) }}><time>{hasValidUnitAnchors(item.unitIndexes) ? item.unitIndexes.map((unitIndex) => formatTime(units[unitIndex].start)).join('–') : 'Unmatched transcript anchor'}</time><span>{item.rationale}</span></button>)}</section>
        <section><div className="debug-section-title">CREATIVE DECISION RATIONALES</div>{original.analysis.creativeRationales.map((item, index) => <button className="debug-rationale" key={index} type="button" disabled={!hasValidUnitAnchors(item.unitIndexes)} onClick={() => { const unit = units[item.unitIndexes[0]]; if (unit) onSeek(unit.start) }}><time>{item.decision}{hasValidUnitAnchors(item.unitIndexes) ? '' : ' · unmatched transcript anchor'}</time><span><strong>{item.selectedValue}</strong><small>{item.rationale}</small></span></button>)}</section>
      </div>}

      <div className="debug-graphs">
        <details><summary>Original GPT scene graph ({original?.layers.length ?? 0} layers, {original?.zooms.length ?? 0} zooms)</summary><p>Structured model output before backend normalization.</p><pre>{JSON.stringify(original ?? null, null, 2)}</pre></details>
        <details><summary>Backend-final scene graph ({backendFinalGraph.layers.length} layers, {backendFinalGraph.zooms.length} zooms)</summary><p>Scene graph returned by the server after normalization and initially supplied to the renderer.</p><pre>{JSON.stringify(backendFinalGraph, null, 2)}</pre></details>
        <details><summary>Current renderer input ({finalGraph.layers.length} layers, {finalGraph.zooms.length} zooms)</summary><p>The live composition currently used by preview and the next export.</p><pre>{JSON.stringify(finalGraph, null, 2)}</pre></details>
        <details open={Boolean(edit.debug?.normalizations.length)}><summary>Backend changes ({edit.debug?.normalizations.length ?? 0})</summary>{edit.debug?.normalizations.length ? <ol className="debug-change-list">{edit.debug.normalizations.map((event) => <li key={event.id}><span className={`debug-event-state debug-state-${event.status}`}>{statusLabels[event.status]}</span><span>{event.message}</span>{event.videoTime !== undefined && <button type="button" onClick={() => onSeek(event.videoTime!)}>{formatTime(event.videoTime)}</button>}</li>)}</ol> : <p>No backend normalization changes were recorded.</p>}</details>
        <details open={showModelOutput} onToggle={(event) => setShowModelOutput(event.currentTarget.open)}><summary>Input transcript ({transcript.length} characters) · {units.length} timed units</summary><p>{transcript}</p><pre>{JSON.stringify(units, null, 2)}</pre></details>
      </div>
      <p className="debug-privacy-note">The JSON report includes transcript and structured model diagnostics, but excludes sampled frame image data and credentials.</p>
    </section>
  )
}
