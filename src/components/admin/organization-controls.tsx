"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { updatePlatformOrganization } from "@/server/actions/platform-admin";

export function OrganizationControls({ organizationId, initialPlan, initialStatus }: { organizationId: string; initialPlan: string; initialStatus: string }) {
  const [plan, setPlan] = useState(initialPlan);
  const [status, setStatus] = useState(initialStatus);
  const [message, setMessage] = useState("");
  const [pending, startTransition] = useTransition();
  const save = () => startTransition(async () => {
    setMessage("");
    const result = await updatePlatformOrganization({ organizationId, plan, status });
    setMessage(result.ok ? "Platform settings saved." : result.error);
  });
  return <div className="space-y-4"><div className="grid gap-3 sm:grid-cols-2"><div><Label htmlFor="admin-plan">Plan</Label><Select id="admin-plan" value={plan} onChange={event => setPlan(event.target.value)}><option value="pilot">Pilot</option><option value="starter">Starter</option><option value="restaurant">Restaurant</option><option value="multi_location">Multi-location</option></Select></div><div><Label htmlFor="admin-status">Access status</Label><Select id="admin-status" value={status} onChange={event => setStatus(event.target.value)}><option value="active">Active</option><option value="pilot">Pilot</option><option value="suspended">Suspended</option><option value="cancelled">Cancelled</option></Select></div></div><div className="flex items-center gap-3"><Button type="button" onClick={save} disabled={pending}>{pending ? "Saving…" : "Save platform settings"}</Button>{message && <p className="text-sm text-[var(--muted)]">{message}</p>}</div></div>;
}
