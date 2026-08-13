"use client";

import { useState, useTransition } from "react";
import { Copy, Check, Mail, ShieldAlert, UserPlus, Users, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, FormError } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import {
  changeMemberLocation,
  changeMemberRole,
  inviteEmployee,
  removeMember,
  resendInvitation,
  revokeInvitation,
} from "@/server/actions/team";
import type { PendingInvitationRow, TeamMemberRow } from "@/server/queries/team";
import type { LocationOption } from "@/server/queries/locations";
import type { MemberRole } from "@/server/tenant";

/**
 * Team roster and invitation management.
 *
 * Every control here is a convenience: the same rules are enforced in
 * `server/actions/team`, so hiding a button never decides anything. Disabling
 * is used to explain *why* something is unavailable rather than to secure it.
 */

const ROLE_TONE: Record<MemberRole, "neutral" | "success" | "warning" | "danger"> = {
  owner: "danger",
  manager: "success",
  inventory: "warning",
  kitchen: "neutral",
  accountant: "neutral",
};

/** Shown to the inviter after an invitation is created or resent. */
function InviteLinkPanel({ token, email, onDone }: { token: string; email: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const url = typeof window === "undefined" ? "" : `${window.location.origin}/invite/${token}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Could not copy. Select the link and copy it manually.");
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-green-200 bg-green-50/60 p-4">
        <p className="text-sm font-bold text-green-900">Invitation ready for {email}</p>
        <p className="mt-1 text-sm text-green-900/80">
          Send them this link. It works once, expires in 7 days, and only opens for this email address.
        </p>
      </div>

      <div className="flex gap-2">
        <Input readOnly value={url} onFocus={event => event.currentTarget.select()} className="font-mono text-xs" />
        <Button type="button" onClick={copy} className="shrink-0">
          {copied ? <Check size={16} /> : <Copy size={16} />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>

      <p className="text-xs text-[var(--muted)]">
        This link is shown once and cannot be recovered. If it is lost, use Resend to issue a new one — which
        invalidates this link.
      </p>

      <Button type="button" variant="secondary" onClick={onDone} className="w-full">
        Done
      </Button>
    </div>
  );
}

export function TeamManager({
  members,
  invitations,
  locations,
  canManageTeam,
  canTransferOwnership,
}: {
  members: TeamMemberRow[];
  invitations: PendingInvitationRow[];
  locations: LocationOption[];
  canManageTeam: boolean;
  canTransferOwnership: boolean;
}) {
  const [inviteOpen, setInviteOpen] = useState(false);
  const [issued, setIssued] = useState<{ token: string; email: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<{ kind: "remove" | "promote"; member: TeamMemberRow } | null>(null);
  const [pending, startTransition] = useTransition();

  const ownerCount = members.filter(member => member.role === "owner").length;

  const submitInvite = (formData: FormData) => {
    setError(null);
    setFieldErrors({});
    startTransition(async () => {
      const result = await inviteEmployee({
        email: String(formData.get("email") ?? ""),
        role: String(formData.get("role") ?? ""),
        defaultLocationId: String(formData.get("defaultLocationId") ?? ""),
      });
      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }
      setIssued({ token: result.data.token, email: result.data.email });
    });
  };

  const applyRole = (member: TeamMemberRow, role: MemberRole) => {
    if (role === "owner" || member.role === "owner") {
      setConfirming({ kind: "promote", member: { ...member, role } });
      return;
    }
    startTransition(async () => {
      const result = await changeMemberRole({ userId: member.userId, role });
      if (!result.ok) toast.error(result.error);
      else toast.success(`${member.displayName} is now ${role}.`);
    });
  };

  const confirmOwnershipChange = () => {
    if (!confirming) return;
    const { member } = confirming;
    startTransition(async () => {
      const result = await changeMemberRole({ userId: member.userId, role: member.role });
      if (!result.ok) toast.error(result.error);
      else toast.success(`${member.displayName} is now ${member.role}.`);
      setConfirming(null);
    });
  };

  const confirmRemove = () => {
    if (!confirming) return;
    const { member } = confirming;
    startTransition(async () => {
      const result = await removeMember(member.userId);
      if (!result.ok) toast.error(result.error);
      else toast.success(`${member.displayName} was removed.`);
      setConfirming(null);
    });
  };

  return (
    <div className="space-y-6">
      <Card className="overflow-hidden">
        <CardHeader className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-black">Team</h2>
            <p className="text-sm text-[var(--muted)]">
              {members.length} {members.length === 1 ? "person" : "people"} with access to this workspace
            </p>
          </div>
          {canManageTeam && (
            <Button
              onClick={() => {
                setIssued(null);
                setError(null);
                setInviteOpen(true);
              }}
            >
              <UserPlus size={16} /> Invite employee
            </Button>
          )}
        </CardHeader>

        <Table className="min-w-[820px]">
          <THead>
            <TR className="hover:bg-transparent">
              <TH>Employee</TH>
              <TH>Role</TH>
              <TH>Default location</TH>
              <TH>Joined</TH>
              {canManageTeam && <TH className="text-right">Actions</TH>}
            </TR>
          </THead>
          <TBody>
            {members.map(member => {
              // The only owner cannot be demoted or removed — the workspace
              // would be left with nobody able to manage it.
              const isLastOwner = member.role === "owner" && ownerCount <= 1;
              const locked = member.isSelf || isLastOwner || (member.role === "owner" && !canTransferOwnership);

              return (
                <TR key={member.userId}>
                  <TD>
                    <b className="block text-sm">{member.displayName}</b>
                    <span className="block text-xs text-[var(--muted)]">{member.email || "No email on file"}</span>
                  </TD>
                  <TD>
                    {canManageTeam && !locked ? (
                      <Select
                        value={member.role}
                        disabled={pending}
                        onChange={event => applyRole(member, event.currentTarget.value as MemberRole)}
                        className="h-9 w-40"
                      >
                        {(canTransferOwnership ? (["owner", "manager", "inventory", "kitchen", "accountant"] as const) : (["manager", "inventory", "kitchen", "accountant"] as const)).map(role => (
                          <option key={role} value={role}>
                            {role[0].toUpperCase() + role.slice(1)}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <Badge tone={ROLE_TONE[member.role]}>{member.role[0].toUpperCase() + member.role.slice(1)}</Badge>
                    )}
                    {member.isSelf && <span className="ml-2 text-xs text-[var(--muted)]">You</span>}
                  </TD>
                  <TD>
                    {canManageTeam && !member.isSelf ? (
                      <Select
                        value={member.defaultLocationId ?? ""}
                        disabled={pending}
                        onChange={event =>
                          startTransition(async () => {
                            const result = await changeMemberLocation({
                              userId: member.userId,
                              defaultLocationId: event.currentTarget.value,
                            });
                            if (!result.ok) toast.error(result.error);
                            else toast.success("Default location updated.");
                          })
                        }
                        className="h-9 w-44"
                      >
                        <option value="">All / unassigned</option>
                        {locations.map(location => (
                          <option key={location.id} value={location.id}>
                            {location.name}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <span className="text-sm text-[var(--muted)]">{member.defaultLocationName ?? "All / unassigned"}</span>
                    )}
                  </TD>
                  <TD className="text-sm text-[var(--muted)]">{member.joinedAt.toLocaleDateString()}</TD>
                  {canManageTeam && (
                    <TD className="text-right">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={pending || member.isSelf || isLastOwner}
                        title={isLastOwner ? "Promote another owner first" : member.isSelf ? "You cannot remove yourself" : undefined}
                        onClick={() => setConfirming({ kind: "remove", member })}
                      >
                        Remove
                      </Button>
                    </TD>
                  )}
                </TR>
              );
            })}
          </TBody>
        </Table>
      </Card>

      {/* ------------------------------------------------ pending invitations */}
      {canManageTeam && (
        <Card className="overflow-hidden">
          <CardHeader>
            <h2 className="text-lg font-black">Pending invitations</h2>
            <p className="text-sm text-[var(--muted)]">People invited who have not joined yet</p>
          </CardHeader>

          {invitations.length === 0 ? (
            <CardContent>
              <EmptyState
                icon={Mail}
                title="No pending invitations"
                description="Invite a colleague and share the link with them to add them to this workspace."
                className="py-6"
              />
            </CardContent>
          ) : (
            <Table className="min-w-[760px]">
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Email</TH>
                  <TH>Role</TH>
                  <TH>Location</TH>
                  <TH>Status</TH>
                  <TH className="text-right">Actions</TH>
                </TR>
              </THead>
              <TBody>
                {invitations.map(invitation => (
                  <TR key={invitation.id}>
                    <TD>
                      <b className="text-sm">{invitation.email}</b>
                      {invitation.invitedByName && (
                        <span className="block text-xs text-[var(--muted)]">Invited by {invitation.invitedByName}</span>
                      )}
                    </TD>
                    <TD>
                      <Badge tone={ROLE_TONE[invitation.role]}>
                        {invitation.role[0].toUpperCase() + invitation.role.slice(1)}
                      </Badge>
                    </TD>
                    <TD className="text-sm text-[var(--muted)]">{invitation.locationName ?? "All / unassigned"}</TD>
                    <TD>
                      {invitation.isExpired ? (
                        <Badge tone="danger">Expired</Badge>
                      ) : (
                        <span className="text-xs text-[var(--muted)]">
                          Expires {invitation.expiresAt.toLocaleDateString()}
                        </span>
                      )}
                    </TD>
                    <TD className="text-right">
                      <span className="inline-flex gap-2">
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={pending}
                          onClick={() =>
                            startTransition(async () => {
                              const result = await resendInvitation(invitation.id);
                              if (!result.ok) toast.error(result.error);
                              else setIssued({ token: result.data.token, email: result.data.email });
                            })
                          }
                        >
                          Resend
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={pending}
                          onClick={() =>
                            startTransition(async () => {
                              const result = await revokeInvitation(invitation.id);
                              if (!result.ok) toast.error(result.error);
                              else toast.success("Invitation cancelled.");
                            })
                          }
                        >
                          <X size={14} /> Cancel
                        </Button>
                      </span>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      )}

      {/* ------------------------------------------------------- invite modal */}
      <Modal open={inviteOpen} onClose={() => setInviteOpen(false)} title="Invite employee">
        {issued ? (
          <InviteLinkPanel
            token={issued.token}
            email={issued.email}
            onDone={() => {
              setIssued(null);
              setInviteOpen(false);
            }}
          />
        ) : (
          <form action={submitInvite} className="space-y-4">
            <Field label="Email" error={fieldErrors.email}>
              <Input name="email" type="email" required placeholder="colleague@restaurant.com" autoFocus />
            </Field>

            <Field label="Role" error={fieldErrors.role} hint="Owner cannot be granted by invitation — promote an existing member instead.">
              <Select name="role" defaultValue="kitchen" required>
                <option value="manager">Manager — runs operations and the team</option>
                <option value="inventory">Inventory — stock, purchasing and suppliers</option>
                <option value="kitchen">Kitchen — recipes, menu and daily operations</option>
                <option value="accountant">Accountant — read-only, including financials</option>
              </Select>
            </Field>

            <Field label="Default location" error={fieldErrors.defaultLocationId} hint="Inventory and kitchen staff are restricted to this location.">
              <Select name="defaultLocationId" defaultValue="">
                <option value="">All / unassigned</option>
                {locations.map(location => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </Select>
            </Field>

            <FormError message={error} />

            <Button type="submit" disabled={pending} className="w-full">
              {pending ? "Creating invitation…" : "Create invitation link"}
            </Button>
          </form>
        )}
      </Modal>

      {/* -------------------------------------------------- confirm dialogues */}
      <Modal
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title={confirming?.kind === "remove" ? "Remove employee" : "Change ownership"}
      >
        {confirming && (
          <div className="space-y-4">
            {confirming.kind === "remove" ? (
              <p className="text-sm">
                Remove <b>{confirming.member.displayName}</b> from this workspace? They keep their account but lose all
                access to your data. Their recorded history stays intact.
              </p>
            ) : (
              <div className="space-y-3">
                <p className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50/70 p-3 text-sm text-amber-900">
                  <ShieldAlert size={18} className="mt-0.5 shrink-0" />
                  <span>
                    {confirming.member.role === "owner" ? (
                      <>
                        Making <b>{confirming.member.displayName}</b> an owner grants full control of this workspace,
                        including billing, team management and the ability to remove you.
                      </>
                    ) : (
                      <>
                        Removing ownership from <b>{confirming.member.displayName}</b> revokes their full control of
                        this workspace.
                      </>
                    )}
                  </span>
                </p>
              </div>
            )}

            <div className="flex gap-2">
              <Button variant="secondary" className="flex-1" onClick={() => setConfirming(null)} disabled={pending}>
                Cancel
              </Button>
              <Button
                className="flex-1"
                disabled={pending}
                onClick={confirming.kind === "remove" ? confirmRemove : confirmOwnershipChange}
              >
                {pending ? "Working…" : confirming.kind === "remove" ? "Remove" : "Confirm"}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {members.length === 0 && (
        <Card>
          <EmptyState
            icon={Users}
            title="No team members yet"
            description="Invite your first employee to give them access to this workspace."
          />
        </Card>
      )}
    </div>
  );
}
