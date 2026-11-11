import type { ColorMode } from '../api'

const swatches: Record<ColorMode, string[]> = {
  bw: ['#111111', '#ffffff'],
  bwr: ['#111111', '#ffffff', '#dc2626'],
  bwry: ['#111111', '#ffffff', '#dc2626', '#facc15'],
}

export default function ColorModeBadge({ mode, className = '' }: { mode: ColorMode; className?: string }) {
  const colors = swatches[mode] ?? swatches.bw
  return <span className={`color-badge ${mode} ${className}`.trim()} title={mode.toUpperCase()}>
    <span className="color-badge-swatches" aria-hidden="true">{colors.map(color => <i key={color} style={{ background: color }} />)}</span>
    <b>{mode.toUpperCase()}</b>
  </span>
}
