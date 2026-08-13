"use client";
import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { safeNextPath } from "@/lib/redirects";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState(""); const [message, setMessage] = useState(""); const [loading, setLoading] = useState(false);
  // Set when the visitor arrived from an invitation link, so they land back on
  // it after authenticating instead of being sent to create their own workspace.
  // Same-origin paths only, so `?next=` can never become an open redirect — the
  // rule lives in `lib/redirects` and is shared with the auth callback route.
  const next = safeNextPath(searchParams.get("next"));
  const authLink = (path: string) => (next ? `${path}?next=${encodeURIComponent(next)}` : path);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setLoading(true); setError(""); setMessage(""); const form = new FormData(event.currentTarget); const email = String(form.get("email")); const password = String(form.get("password")); const supabase = createClient();
    const callback = next ? `${location.origin}/auth/callback?next=${encodeURIComponent(next)}` : `${location.origin}/auth/callback`;
    const result = mode === "login" ? await supabase.auth.signInWithPassword({ email, password }) : await supabase.auth.signUp({ email, password, options: { emailRedirectTo: callback } });
    setLoading(false); if (result.error) return setError(result.error.message); if (mode === "signup" && !result.data.session) { setMessage("Account created. Check your email, confirm it, then sign in."); return; } router.push(next ?? (mode === "login" ? "/dashboard" : "/onboarding")); router.refresh();
  }
  return <form onSubmit={submit} className="space-y-4"><div><Label htmlFor="email">Email</Label><Input id="email" name="email" type="email" required /></div><div><Label htmlFor="password">Password</Label><Input id="password" name="password" type="password" minLength={8} required /></div>{error && <p className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}{message && <p className="rounded-xl bg-green-50 p-3 text-sm text-green-800">{message}</p>}<Button className="w-full" disabled={loading}>{loading ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}</Button><p className="text-center text-sm text-[var(--muted)]">{mode === "login" ? "New here?" : "Already registered?"} <Link className="font-bold text-green-800" href={authLink(mode === "login" ? "/auth/sign-up" : "/auth/login")}>{mode === "login" ? "Create an account" : "Sign in"}</Link></p></form>;
}
