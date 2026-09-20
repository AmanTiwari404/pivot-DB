import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Plus, Play, Trash2 } from 'lucide-react'
import Editor from '@monaco-editor/react'
import { api } from '../../lib/api'
import { BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, Tooltip, ResponsiveContainer, XAxis, YAxis } from 'recharts'

interface Stage { type: string; body: string }

const STAGE_TYPES = ['$match', '$group', '$sort', '$project', '$limit', '$unwind', '$lookup', '$addFields', '$count', '$facet']
const CHART_COLORS = ['#4ade80', '#60a5fa', '#f59e0b', '#f87171', '#a78bfa', '#34d399']

interface Props {
  connectionId: string
  database: string
  collection: string
}

export function AggregationEditor({ connectionId, database, collection }: Props) {
  const [stages, setStages] = useState<Stage[]>([{ type: '$match', body: '{}' }])
  const [results, setResults] = useState<Record<string, unknown>[] | null>(null)
  const [chartType, setChartType] = useState<'none' | 'bar' | 'line' | 'pie'>('none')
  const [xKey, setXKey] = useState('')
  const [yKey, setYKey] = useState('')

  const runMutation = useMutation({
    mutationFn: () => {
      const pipeline = stages.map((s) => {
        try { return { [s.type]: JSON.parse(s.body) } } catch { return { [s.type]: {} } }
      })
      return api.post<{ results: Record<string, unknown>[] }>(
        `/api/connections/${connectionId}/explore/databases/${database}/collections/${collection}/aggregate`,
        { pipeline, limit: 1000 }
      )
    },
    onSuccess: (data) => {
      setResults(data.results)
      if (data.results.length > 0) {
        const keys = Object.keys(data.results[0])
        setXKey(keys[0] ?? '')
        setYKey(keys[1] ?? keys[0] ?? '')
      }
    },
  })

  const addStage = () => setStages([...stages, { type: '$match', body: '{}' }])
  const removeStage = (i: number) => setStages(stages.filter((_, j) => j !== i))
  const updateStage = (i: number, patch: Partial<Stage>) =>
    setStages(stages.map((s, j) => (j === i ? { ...s, ...patch } : s)))

  const resultColumns = results && results.length > 0 ? Object.keys(results[0]) : []

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Pipeline editor */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {stages.map((stage, i) => (
          <div key={i} className="border border-border rounded bg-secondary/20">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
              <span className="text-xs text-muted-foreground">Stage {i + 1}</span>
              <select
                value={stage.type}
                onChange={(e) => updateStage(i, { type: e.target.value })}
                className="bg-input border border-border rounded px-2 py-0.5 text-xs"
              >
                {STAGE_TYPES.map((t) => <option key={t}>{t}</option>)}
              </select>
              <div className="flex-1" />
              <button onClick={() => removeStage(i)} className="text-muted-foreground hover:text-destructive">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            <div style={{ height: 120 }}>
              <Editor
                height={120}
                defaultLanguage="json"
                value={stage.body}
                onChange={(v) => updateStage(i, { body: v ?? '{}' })}
                theme="vs-dark"
                options={{ minimap: { enabled: false }, fontSize: 12, lineNumbers: 'off', scrollBeyondLastLine: false }}
              />
            </div>
          </div>
        ))}
        <div className="flex gap-2">
          <button onClick={addStage} className="flex items-center gap-1 text-xs px-3 py-1.5 rounded border border-border text-muted-foreground hover:text-foreground">
            <Plus className="h-3 w-3" /> Add Stage
          </button>
          <button
            onClick={() => runMutation.mutate()}
            disabled={runMutation.isPending}
            className="flex items-center gap-1 text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            <Play className="h-3 w-3" /> {runMutation.isPending ? 'Running…' : 'Run Pipeline'}
          </button>
        </div>
      </div>

      {/* Results */}
      {results && (
        <div className="border-t border-border flex-1 overflow-auto p-4">
          <div className="flex items-center gap-3 mb-3">
            <p className="text-xs text-muted-foreground">{results.length} results</p>
            <div className="flex items-center gap-2 ml-auto">
              <select value={chartType} onChange={(e) => setChartType(e.target.value as typeof chartType)}
                className="bg-input border border-border rounded px-2 py-0.5 text-xs">
                <option value="none">Table</option>
                <option value="bar">Bar Chart</option>
                <option value="line">Line Chart</option>
                <option value="pie">Pie Chart</option>
              </select>
              {chartType !== 'none' && (
                <>
                  <select value={xKey} onChange={(e) => setXKey(e.target.value)}
                    className="bg-input border border-border rounded px-2 py-0.5 text-xs">
                    {resultColumns.map((c) => <option key={c}>{c}</option>)}
                  </select>
                  <select value={yKey} onChange={(e) => setYKey(e.target.value)}
                    className="bg-input border border-border rounded px-2 py-0.5 text-xs">
                    {resultColumns.map((c) => <option key={c}>{c}</option>)}
                  </select>
                </>
              )}
            </div>
          </div>

          {chartType === 'bar' && (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={results}>
                <XAxis dataKey={xKey} tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip />
                <Bar dataKey={yKey} fill="#4ade80" />
              </BarChart>
            </ResponsiveContainer>
          )}
          {chartType === 'line' && (
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={results}>
                <XAxis dataKey={xKey} tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip />
                <Line dataKey={yKey} stroke="#4ade80" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
          {chartType === 'pie' && (
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={results} dataKey={yKey} nameKey={xKey} cx="50%" cy="50%" outerRadius={80}>
                  {results.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          )}

          {chartType === 'none' && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="border-b border-border">
                  {resultColumns.map((c) => <th key={c} className="text-left px-2 py-1.5 text-muted-foreground">{c}</th>)}
                </tr></thead>
                <tbody>
                  {results.map((row, i) => (
                    <tr key={i} className="border-b border-border/30 hover:bg-secondary/20">
                      {resultColumns.map((c) => (
                        <td key={c} className="px-2 py-1.5 font-mono">{JSON.stringify(row[c])}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
