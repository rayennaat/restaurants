"use client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { Toaster } from "sonner";
import { OfflineSync } from "@/components/providers/offline-sync";

export function AppProviders({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } } }));
  return <QueryClientProvider client={client}><OfflineSync />{children}<Toaster richColors position="top-right" /></QueryClientProvider>;
}
