'use client'

import type { PipelineEvent } from '@/lib/captions'

type Props = { events: PipelineEvent[] }

export default function PipelineLiveStatus({ events }: Props) {
  if (!events.length) return null
  const latest = events.slice(-5).reverse()
  return (
    <section className="pipeline-live" aria-label="Live pipeline activity">
      <div className="pipeline-live-heading"><span>LIVE PIPELINE ACTIVITY</span><strong>{events.length} recorded events</strong></div>
      <ol aria-live="polite" aria-relevant="additions text">
        {latest.map((event) => <li className={`pipeline-live-${event.status}`} key={event.id}><i aria-hidden="true" /><span><strong>{event.stage.replaceAll('-', ' ')}</strong><small>{event.message}</small></span><time>{new Date(event.at).toLocaleTimeString()}</time></li>)}
      </ol>
    </section>
  )
}
