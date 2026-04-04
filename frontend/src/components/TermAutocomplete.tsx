import { useState, useEffect, useRef, useCallback } from "react"
import { useQuery } from "@tanstack/react-query"
import { Search, Loader2, X } from "lucide-react"
import { autocomplete, type AutocompleteItem } from "@/lib/api"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"

interface Props {
  field: string
  value: string
  /** Optional initial label to display (from model objects) */
  valueLabel?: string
  taxon?: string | null
  placeholder?: string
  onChange: (id: string, label: string) => void
}

export function TermAutocomplete({ field, value, valueLabel, taxon, placeholder, onChange }: Props) {
  // The actual selected term ID (what gets saved)
  const [selectedId, setSelectedId] = useState(value)
  const [selectedLabel, setSelectedLabel] = useState(valueLabel ?? "")
  // What the user is typing in the search box
  const [searchText, setSearchText] = useState("")
  const [isSearching, setIsSearching] = useState(false)
  const [debouncedQuery, setDebouncedQuery] = useState("")
  const [open, setOpen] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)

  // Sync external value changes
  useEffect(() => {
    setSelectedId(value)
    if (valueLabel) setSelectedLabel(valueLabel)
  }, [value, valueLabel])

  // Debounce search text
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(searchText.length >= 2 ? searchText : "")
    }, 250)
    return () => clearTimeout(timer)
  }, [searchText])

  const { data: results, isFetching } = useQuery({
    queryKey: ["autocomplete", field, debouncedQuery, taxon],
    queryFn: () => autocomplete(field, debouncedQuery, taxon),
    enabled: debouncedQuery.length >= 2,
    staleTime: 60_000,
  })

  const items = results ?? []

  useEffect(() => { setSelectedIndex(0) }, [items])

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
        if (isSearching) setIsSearching(false)
      }
    }
    document.addEventListener("mousedown", handleClick)
    return () => document.removeEventListener("mousedown", handleClick)
  }, [isSearching])

  const selectItem = useCallback(
    (item: AutocompleteItem) => {
      setSelectedId(item.id)
      setSelectedLabel(item.label)
      setSearchText("")
      setIsSearching(false)
      setOpen(false)
      onChange(item.id, item.label)
    },
    [onChange]
  )

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open || items.length === 0) {
      if (e.key === "Escape") {
        setIsSearching(false)
        setOpen(false)
      }
      return
    }
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
      setIsSearching(false)
      setOpen(false)
    }
  }

  function startSearch() {
    setIsSearching(true)
    setSearchText("")
  }

  function clearSelection() {
    setSelectedId("")
    setSelectedLabel("")
    setSearchText("")
    setIsSearching(true)
    onChange("", "")
  }

  // Show the selected value display OR the search input
  if (selectedId && !isSearching) {
    return (
      <div
        ref={containerRef}
        className="flex items-center gap-1 rounded border bg-muted/30 px-2 py-1 cursor-pointer group"
        onClick={startSearch}
      >
        <div className="flex-1 min-w-0">
          <p className="text-[11px] font-medium truncate">
            {selectedLabel || selectedId}
          </p>
          {selectedLabel && (
            <p className="text-[9px] text-muted-foreground font-mono truncate">
              {selectedId}
            </p>
          )}
        </div>
        <button
          className="opacity-0 group-hover:opacity-100 transition-opacity h-4 w-4 flex items-center justify-center"
          onClick={(e) => { e.stopPropagation(); clearSelection() }}
        >
          <X className="h-3 w-3 text-muted-foreground" />
        </button>
      </div>
    )
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Search className="absolute left-2 top-1.5 h-3 w-3 text-muted-foreground" />
        <Input
          autoFocus={isSearching}
          value={searchText}
          onChange={(e) => {
            setSearchText(e.target.value)
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
                <p className="font-medium truncate">{item.label}</p>
                <p className="text-muted-foreground font-mono text-[9px]">{item.id}</p>
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
