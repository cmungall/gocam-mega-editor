import { BrowserRouter, Routes, Route } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ModelList } from "@/components/ModelList"
import { GraphView } from "@/components/GraphView"
import { MegaGraphView } from "@/components/MegaGraphView"

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5 * 60 * 1000, retry: 1 },
  },
})

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <div className="h-screen flex flex-col">
          <Routes>
            <Route
              path="/"
              element={
                <div className="h-full">
                  <ModelList />
                </div>
              }
            />
            <Route path="/model/:modelId" element={<GraphView />} />
            <Route path="/mega" element={<MegaGraphView />} />
          </Routes>
        </div>
      </BrowserRouter>
    </QueryClientProvider>
  )
}

export default App
