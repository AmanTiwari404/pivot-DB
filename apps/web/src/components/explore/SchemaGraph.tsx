import React from 'react'
import { useQuery } from '@tanstack/react-query'
import { ReactFlow, Background, Controls, Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { api } from '../../lib/api'

interface FieldInfo {
  path: string
  types: string[]
  presencePercent: number
  nullRate: number
  cardinality: number
  isMixedType: boolean
  min?: number
  max?: number
  avg?: number
}

interface SchemaResult {
  fields: FieldInfo[]
  sampleSize: number
  totalDocuments: number
}

interface Props {
  connectionId: string
  database: string
  collection: string
}

function typeColor(types: string[]): string {
  if (types.includes('objectId')) return 'text-orange-400'
  if (types.includes('string')) return 'text-green-400'
  if (types.includes('int') || types.includes('double') || types.includes('number')) return 'text-blue-400'
  if (types.includes('date')) return 'text-purple-400'
  if (types.includes('boolean')) return 'text-yellow-400'
  if (types.includes('array')) return 'text-pink-400'
  if (types.includes('object')) return 'text-cyan-400'
  return 'text-muted-foreground'
}

export function SchemaGraph({ connectionId, database, collection }: Props) {
  const [selectedField, setSelectedField] = React.useState<FieldInfo | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['schema', connectionId, database, collection],
    queryFn: () => api.post<SchemaResult>(
      `/api/connections/${connectionId}/explore/databases/${database}/collections/${collection}/schema`,
      { sampleSize: 1000 }
    ),
  })

  if (isLoading) return <div className="p-4 text-sm text-muted-foreground">Sampling schema…</div>
  if (!data) return null

  const topLevelFields = data.fields.filter((f) => !f.path.includes('.'))

  const nodes: Node[] = [
    {
      id: collection,
      position: { x: 100, y: 100 },
      data: {
        label: (
          <div className="bg-card border border-border rounded p-3 min-w-[200px] shadow">
            <p className="font-semibold text-sm text-foreground border-b border-border pb-2 mb-2">{collection}</p>
            <div className="space-y-1 max-h-60 overflow-y-auto">
              {topLevelFields.map((f) => (
                <div
                  key={f.path}
                  className="flex items-center justify-between cursor-pointer hover:bg-secondary/50 px-1 rounded"
                  onClick={() => setSelectedField(f)}
                >
                  <span className="text-xs text-foreground">{f.path}</span>
                  <span className={`text-xs ml-2 ${typeColor(f.types)}`}>
                    {f.types.join('|')}
                    {f.isMixedType && ' ⚠️'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ),
      },
      type: 'default',
      style: { background: 'transparent', border: 'none', padding: 0 },
    },
  ]

  return (
    <div className="flex h-full">
      <div className="flex-1">
        <ReactFlow nodes={nodes} edges={[]} fitView>
          <Background color="hsl(var(--border))" gap={20} />
          <Controls />
        </ReactFlow>
      </div>

      {selectedField && (
        <div className="w-72 border-l border-border p-4 bg-card overflow-y-auto shrink-0">
          <p className="text-sm font-semibold mb-3">{selectedField.path}</p>
          <div className="space-y-2 text-xs">
            {[
              ['Types', selectedField.types.join(', ')],
              ['Presence', `${selectedField.presencePercent.toFixed(1)}%`],
              ['Null rate', `${selectedField.nullRate.toFixed(1)}%`],
              ['Cardinality', selectedField.cardinality.toLocaleString()],
              ...(selectedField.min != null ? [
                ['Min', String(selectedField.min)],
                ['Max', String(selectedField.max)],
                ['Avg', selectedField.avg != null ? selectedField.avg.toFixed(2) : '—'],
              ] : []),
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between">
                <span className="text-muted-foreground">{label}</span>
                <span>{value}</span>
              </div>
            ))}
          </div>
          {selectedField.isMixedType && (
            <p className="mt-3 text-xs text-yellow-400 bg-yellow-500/10 rounded p-2">
              Mixed types detected — this field contains multiple data types.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
