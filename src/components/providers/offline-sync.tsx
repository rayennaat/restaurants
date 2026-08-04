"use client";
import { useEffect } from "react";
import { toast } from "sonner";
import { syncPendingOperations } from "@/lib/offline/db";
export function OfflineSync() {
  useEffect(() => {
    const sync = async () => { await syncPendingOperations(); toast.success("Offline entries synchronized"); };
    window.addEventListener("online", sync);
    if (navigator.onLine) void syncPendingOperations();
    return () => window.removeEventListener("online", sync);
  }, []);
  return null;
}
