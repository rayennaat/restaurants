"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Ban, PackageCheck, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FormError } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { cancelTransfer, receiveTransfer, sendTransfer } from "@/server/actions/transfers";

/**
 * The three state changes a transfer can undergo, as buttons.
 *
 * Each one is disabled while its request is in flight. That is a courtesy, not
 * the safety mechanism: the server claims the row with a conditional UPDATE, so
 * a double-click, a retry, or two colleagues pressing at once all resolve to one
 * state change and one set of ledger movements.
 */

export function SendTransferButton({ transferId }: { transferId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const send = () => {
    setError(null);
    startTransition(async () => {
      const result = await sendTransfer({ transferId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success("Transfer sent. The stock has left the source.");
      router.refresh();
    });
  };

  return (
    <div className="space-y-2">
      <Button onClick={send} disabled={pending}>
        {pending ? "Sending…" : (<><Send size={16} /> Send transfer</>)}
      </Button>
      <FormError message={error} />
    </div>
  );
}

export function ReceiveTransferButton({ transferId, destinationName }: { transferId: string; destinationName: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const receive = () => {
    setError(null);
    startTransition(async () => {
      const result = await receiveTransfer({ transferId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success(`Received. Stock has been added to ${destinationName}.`);
      router.refresh();
    });
  };

  return (
    <div className="space-y-2">
      <Button onClick={receive} disabled={pending}>
        {pending ? "Confirming…" : (<><PackageCheck size={16} /> Confirm received</>)}
      </Button>
      <FormError message={error} />
    </div>
  );
}

/**
 * Cancelling.
 *
 * A reason is required, matching how a rejected stock count must explain itself
 * — the other site needs to know why the stock is not coming. If the transfer
 * was already sent, the server returns the goods to the source.
 */
export function CancelTransferButton({ transferId, wasSent }: { transferId: string; wasSent: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const cancel = () => {
    setError(null);
    if (!reason.trim()) {
      setError("Give a reason so the other location knows what happened.");
      return;
    }

    startTransition(async () => {
      const result = await cancelTransfer({ transferId, reason });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      toast.success(wasSent ? "Cancelled. The stock has been returned to the source." : "Transfer cancelled.");
      router.refresh();
    });
  };

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <Ban size={16} /> Cancel transfer
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} title="Cancel this transfer">
        <div className="space-y-4">
          <p className="text-sm text-[var(--muted)]">
            {wasSent
              ? "This transfer has already been sent, so the stock will be returned to the source location. Both the dispatch and the return stay on the record."
              : "This is still a draft, so no stock has moved. Cancelling simply closes it."}
          </p>

          <Field label="Reason" required>
            <Input value={reason} onChange={event => setReason(event.target.value)} placeholder="e.g. Van broke down, sending tomorrow" />
          </Field>

          <FormError message={error} />

          <div className="flex gap-3">
            <Button variant="danger" onClick={cancel} disabled={pending} className="flex-1">
              {pending ? "Cancelling…" : "Cancel transfer"}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={pending}>
              Keep it
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
