"use client";

import Link from "next/link";
import { useState } from "react";
import { requestPasswordReset } from "@/server/actions/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setMessage("");
    setError("");
    const result = await requestPasswordReset(email);
    setLoading(false);
    if (!result.ok) return setError(result.error);
    setMessage("If an account exists for this email, you will receive a password reset link shortly.");
  }

  return (
    <main className="grid min-h-screen place-items-center p-5">
      <div className="w-full max-w-md rounded-lg border border-neutral-200 bg-white p-7 shadow-sm">
        <h1 className="text-3xl font-black">Reset your password</h1>
        <p className="mb-7 mt-2 text-[var(--muted)]">Enter your email and we’ll send a secure reset link.</p>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <Label htmlFor="reset-email">Email</Label>
            <Input className="border-neutral-300" id="reset-email" name="email" type="email" value={email} onChange={event => setEmail(event.target.value)} required autoComplete="email" />
          </div>
          {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
          {message && <p className="rounded-lg bg-green-50 p-3 text-sm text-green-800">{message}</p>}
          <Button className="w-full transition-shadow hover:shadow-md" disabled={loading}>{loading ? "Sending…" : "Send reset link"}</Button>
        </form>
        <Link href="/auth/login" className="mt-5 block text-center text-sm font-semibold text-green-800 transition hover:text-green-950 hover:underline">Back to sign in</Link>
      </div>
    </main>
  );
}
