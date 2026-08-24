"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { registerWithAuthorization, resolvePostAuthRoute } from "@/server/actions/auth";
import { createClient } from "@/lib/supabase/client";
import { safeNextPath } from "@/lib/redirects";

export function AuthForm({
  mode,
  token,
  authorizationKind,
  initialEmail,
}: {
  mode: "login" | "signup";
  token?: string;
  authorizationKind?: "employee" | "owner";
  initialEmail?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const next = safeNextPath(searchParams.get("next"));
  const authLink = (path: string) => (next ? `${path}?next=${encodeURIComponent(next)}` : path);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    setMessage("");
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");

    if (mode === "login") {
      const result = await createClient().auth.signInWithPassword({ email, password });
      if (result.error) {
        setLoading(false);
        return setError(result.error.message);
      }
      const destination = await resolvePostAuthRoute(next);
      setLoading(false);
      router.push(destination);
      router.refresh();
      return;
    }

    if (!token || !authorizationKind) {
      setLoading(false);
      setError("Registration is available by invitation only.");
      return;
    }

    const result = await registerWithAuthorization({ email, password, token, kind: authorizationKind });
    setLoading(false);
    if (!result.ok) return setError(result.error);
    setMessage("Account created. Check your email, confirm it, then return to this link.");
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <Label htmlFor="email">Email</Label>
        <Input className="border-neutral-300" id="email" name="email" type="email" required defaultValue={initialEmail} readOnly={Boolean(initialEmail)} />
      </div>
      <div>
        <div className="mb-1.5 flex items-center justify-between gap-3">
          <Label className="mb-0" htmlFor="password">Password</Label>
          {mode === "login" && <Link className="text-xs font-semibold text-green-800 transition hover:text-green-950 hover:underline" href="/auth/forgot-password">Forgot password?</Link>}
        </div>
        <div className="relative">
          <Input className="border-neutral-300 pr-11" id="password" name="password" type={showPassword ? "text" : "password"} minLength={8} required />
          <button
            type="button"
            className="absolute inset-y-0 right-0 grid w-11 place-items-center text-[var(--muted)] transition hover:text-green-800"
            onClick={() => setShowPassword(value => !value)}
            aria-label={showPassword ? "Hide password" : "Show password"}
            title={showPassword ? "Hide password" : "Show password"}
          >
            {showPassword ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
          </button>
        </div>
      </div>
      {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {message && <p className="rounded-lg bg-green-50 p-3 text-sm text-green-800">{message}</p>}
      <Button className="w-full transition-shadow hover:shadow-md" disabled={loading}>{loading ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}</Button>
      {mode === "signup" && <p className="text-center text-sm text-[var(--muted)]">Already registered? <Link className="font-bold text-green-800" href={authLink("/auth/login")}>Sign in</Link></p>}
    </form>
  );
}
