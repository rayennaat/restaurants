"use client";

import { useState, useTransition } from "react";
import { Copy, KeyRound, RotateCcw, ShieldAlert } from "lucide-react";
import { issuePlatformOwnerInvitation, revokePlatformOwnerInvitation } from "@/server/actions/platform-admin";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

export function OwnerInvitationManager({ invitations }: { invitations: Array<{ id: string; email: string; displayStatus: string; expiresAt: Date; createdAt: Date }> }) {
  const [email, setEmail] = useState("");
  const [newLink, setNewLink] = useState<{ url: string; email: string; expiresAt: string } | null>(null);
  const [message, setMessage] = useState("");
  const [pending, startTransition] = useTransition();
  const issue = () => startTransition(async () => {
    setMessage("");
    const result = await issuePlatformOwnerInvitation(email);
    if (!result.ok) return setMessage(result.error);
    setNewLink(result.data);
    setEmail("");
  });
  const revoke = (id: string) => startTransition(async () => {
    const result = await revokePlatformOwnerInvitation(id);
    setMessage(result.ok ? "Invitation revoked." : result.error);
  });
  return <div className="space-y-5">
    <div className="rounded-lg border bg-white p-5 shadow-sm"><div className="flex items-start gap-3"><KeyRound className="mt-0.5 text-green-800" size={20} aria-hidden="true" /><div><h2 className="font-black">Issue owner invitation</h2><p className="mt-1 text-sm text-[var(--muted)]">The account is created only after the recipient uses this expiring, email-bound link.</p></div></div><div className="mt-4 flex max-w-xl flex-col gap-2 sm:flex-row sm:items-end"><div className="flex-1"><Label htmlFor="owner-email">Owner email</Label><Input id="owner-email" type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="owner@restaurant.com" /></div><Button type="button" onClick={issue} disabled={pending || !email}>{pending ? "Issuing…" : "Issue invitation"}</Button></div>{message && <p className="mt-3 text-sm text-red-700">{message}</p>}{newLink && <div className="mt-4 rounded-lg border border-green-200 bg-green-50 p-4"><p className="text-sm font-bold text-green-900">New link for {newLink.email}</p><div className="mt-2 break-all rounded border bg-white p-2 font-mono text-xs text-green-950">{newLink.url}</div><div className="mt-3 flex flex-wrap gap-2"><Button type="button" size="sm" onClick={() => navigator.clipboard.writeText(newLink.url)}><Copy size={14} aria-hidden="true" /> Copy link</Button><Button type="button" size="sm" variant="secondary" onClick={() => setNewLink(null)}>Dismiss</Button></div><p className="mt-2 text-xs text-green-800">Expires {formatDate(new Date(newLink.expiresAt))}. The raw link cannot be recovered after this screen.</p></div>}</div>
    <div className="rounded-lg border bg-white shadow-sm"><div className="border-b px-5 py-4"><h2 className="font-black">Invitation history</h2></div><div className="divide-y">{invitations.length === 0 ? <p className="p-5 text-sm text-[var(--muted)]">No owner invitations yet.</p> : invitations.map(invitation => <div key={invitation.id} className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-semibold">{invitation.email}</p><p className="mt-1 text-xs text-[var(--muted)]">Issued {formatDate(invitation.createdAt)} · Expires {formatDate(invitation.expiresAt)}</p></div><div className="flex items-center gap-2"><Badge tone={invitation.displayStatus === "pending" ? "warning" : invitation.displayStatus === "accepted" ? "success" : invitation.displayStatus === "revoked" || invitation.displayStatus === "expired" ? "danger" : "neutral"}>{invitation.displayStatus}</Badge>{invitation.displayStatus === "pending" && <Button type="button" size="sm" variant="danger" onClick={() => revoke(invitation.id)} disabled={pending}><ShieldAlert size={14} aria-hidden="true" /> Revoke</Button>}{invitation.displayStatus !== "pending" && <Button type="button" size="sm" variant="secondary" onClick={() => { setEmail(invitation.email); window.scrollTo({ top: 0, behavior: "smooth" }); }}><RotateCcw size={14} aria-hidden="true" /> Issue again</Button>}</div></div>)}</div></div>
  </div>;
}

function formatDate(value: Date) { return new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(value); }
