"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { deactivatePlatformUser, deletePlatformUser, reactivatePlatformUser } from "@/server/actions/platform-admin";

export function UserControls({ userId, status }: { userId: string; status: string }) {
  const [message, setMessage] = useState("");
  const [pending, startTransition] = useTransition();
  const disabled = status === "disabled";

  function run(action: "deactivate" | "reactivate" | "delete") {
    if (action === "delete" && !window.confirm("Delete this Auth user and remove their current workspace memberships? Historical records remain.")) return;
    startTransition(async () => {
      setMessage("");
      const result = action === "deactivate"
        ? await deactivatePlatformUser(userId)
        : action === "reactivate"
          ? await reactivatePlatformUser(userId)
          : await deletePlatformUser(userId);
      setMessage(result.ok ? "User access updated." : result.error);
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {disabled ? (
          <Button type="button" onClick={() => run("reactivate")} disabled={pending}>Reactivate access</Button>
        ) : (
          <Button type="button" variant="secondary" onClick={() => run("deactivate")} disabled={pending}>Deactivate access</Button>
        )}
        <Button type="button" variant="danger" onClick={() => run("delete")} disabled={pending}>Delete Auth user</Button>
      </div>
      {message && <p className="text-sm text-[var(--muted)]">{message}</p>}
    </div>
  );
}
