import { useState, useEffect, useRef, useCallback } from "react"
import { useQuery } from "@tanstack/react-query"
import { Search, Loader2 } from "lucide-react"
import { autocomplete, type AutocompleteItem } from "@/lib/api"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"

interface Props {
  field: string
  value: string
  taxon?: string | null
  placeholder?: string
  onChange: (id: string, label: string) => void
}

export function TermAutocomplete({ field, value, taxon, placeholder, onChange }: Props) {
  const [inputValue, setInputValue] = useState(value)
  const [debouncedQuery, setDebouncedQuery] = useState("")
  const [open, setOpen] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Sync external value changes
  useEffect(() => { setInputValue(value) }, [value])

  // Debounce the query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(inputValue.length >= 2 ? inputValue : "")
    }, 250)
    return () => clearTimeout(timer)
  }, [inputValue])

  const { data: results, isFetching } = useQuery({
    queryKey: ["autocomplete", field, debouncedQuery, taxon],
    queryFn: () => autocomplete(field, debouncedQuery, taxon),
    enabled: debouncedQuery.length >= 2,
    staleTime: 60_000,
  })

  const items = results ?? []

  // Reset selection when results change
  useEffect(() => { setSelectedIndex(0) }, [items])

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClick)
    return () => document.removeEventListener("mousedown", handleClick)
  }, [])

  const selectItem = useCallback(
    (item: AutocompleteItem) => {
      setInputValue(item.id)
      setOpen(false)
      onChange(item.id, item.label)
    },
    [onChange]
  )

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open || items.length === 0) return
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setSelectedIndex((i) => Math.min(i + 1, items.length - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setSelectedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === "Enter") {
      e.preventDefault()
      selectItem(items[selectedIndex])
    } else if (e.key === "Escape") {
      setOpen(false)
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Search className="absolute left-2 top-1.5 h-3 w-3 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={inputValue}
          onChange={(e) => {
            setInputValue(e.target.value)
            setOpen(true)
          }}
          onFocus={() => { if (debouncedQuery.length >= 2) setOpen(true) }}
          onKeyDown={handleKeyDown}
          className="h-7 text-[11px] pl-7 pr-7"
          placeholder={placeholder}
        />
        {isFetching && (
          <Loader2 className="absolute right-2 top-1.5 h-3 w-3 animate-spin text-muted-foreground" />
        )}
      </div>

      {open && items.length > 0 && (
        <div className="absolute z-50 top-8 left-0 right-0 bg-popover border rounded-md shadow-lg max-h-52 overflow-y-auto">
          {items.map((item, i) => (
            <button
              key={item.id}
              className={`
                w-full text-left px-2.5 py-1.5 text-[11px] flex items-center gap-2
                hover:bg-accent/50 transition-colors
                ${i === selectedIndex ? "bg-accent" : ""}
              `}
              onMouseEnter={() => setSelectedIndex(i)}
              onClick={() => selectItem(item)}
            >
              <div className="flex-1 min-w-0">
                <span className="font-medium">{item.label}</span>
                <span className="text-muted-foreground ml-1.5 font-mono text-[9px]">{item.id}</span>
              </div>
              {item.category && (
                <Badge variant="secondary" className="text-[8px] h-4 px-1 shrink-0">
                  {item.category}
                </Badge>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
