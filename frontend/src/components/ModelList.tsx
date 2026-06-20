import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { Search, ArrowRight, Loader2, Network } from "lucide-react"
import { fetchModels, type ModelSummary } from "@/lib/api"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"

const DEFAULT_MODEL_LIST_LIMIT = 200
const MAX_MODEL_LIST_LIMIT = 1000

function configuredModelListLimit() {
  const configured = Number.parseInt(import.meta.env.VITE_MODEL_LIST_LIMIT ?? "", 10)
  if (!Number.isFinite(configured) || configured < 1) {
    return DEFAULT_MODEL_LIST_LIMIT
  }
  return Math.min(configured, MAX_MODEL_LIST_LIMIT)
}

export function ModelList() {
  const [search, setSearch] = useState("")
  const [limit] = useState(configuredModelListLimit)

  const { data: models, isLoading, error } = useQuery({
    queryKey: ["models", limit],
    queryFn: () => fetchModels(limit),
  })

  const filtered = models?.filter((m) => {
    const q = search.toLowerCase()
    return (
      m.title.toLowerCase().includes(q) ||
      m.id.toLowerCase().includes(q) ||
      m.groups.some((g) => g.toLowerCase().includes(q)) ||
      m.contributors.some((c) => c.toLowerCase().includes(q))
    )
  }) ?? []

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">GO-CAM Models</h2>
          <Link to="/mega">
            <Button variant="outline" size="sm" className="text-xs">
              <Network className="h-3.5 w-3.5 mr-1.5" />
              Mega-Graph
            </Button>
          </Link>
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by title, ID, group, or contributor..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {filtered.length} model{filtered.length !== 1 ? "s" : ""}
          {search && ` matching "${search}"`}
        </p>
      </div>

      <ScrollArea className="flex-1">
        {isLoading && (
          <div className="flex items-center justify-center p-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}
        {error && (
          <div className="p-4 text-destructive text-sm">
            Failed to load models. Is the backend running on port 8000?
          </div>
        )}
        <div className="p-2 space-y-1">
          {filtered.map((model) => (
            <ModelCard key={model.id} model={model} />
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

function ModelCard({ model }: { model: ModelSummary }) {
  return (
    <Link to={`/model/${model.id}`}>
      <Card className="hover:bg-accent/50 transition-colors cursor-pointer py-3 gap-1">
        <CardHeader className="p-3 pb-1">
          <div className="flex items-start justify-between gap-2">
            <CardTitle className="text-sm font-medium leading-snug">
              {model.title}
            </CardTitle>
            <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          </div>
          <CardDescription className="text-xs font-mono">
            {model.id}
          </CardDescription>
        </CardHeader>
        <div className="px-3 pb-2 flex gap-1.5 flex-wrap items-center">
          {model.groups.map((g) => (
            <Badge key={g} variant="default" className="text-[10px]">
              {g}
            </Badge>
          ))}
          {model.date && (
            <span className="text-[10px] text-muted-foreground">{model.date}</span>
          )}
          {model.contributors.length > 0 && (
            <span className="text-[10px] text-muted-foreground truncate max-w-48">
              {model.contributors.join(", ")}
            </span>
          )}
        </div>
      </Card>
    </Link>
  )
}
