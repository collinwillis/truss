import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@truss/ui/components/alert-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@truss/ui/components/avatar";
import { Badge } from "@truss/ui/components/badge";
import { Button } from "@truss/ui/components/button";
import { Skeleton } from "@truss/ui/components/skeleton";
import { ArrowLeft, Ban, CheckCircle2, Loader2, Trash2, UserMinus } from "lucide-react";
import { useState, type JSX } from "react";

import { AppAccessSelect } from "../access/app-access-select";
import { APP_NAMES, APP_NOUNS, ITEM_LEVEL_LABELS, getMemberInitials } from "../access/labels";
import type { AppAccessSetting, EffectiveAppAccess } from "../access/types";
import type { AppName } from "../organizations/types";
import { ADMIN_PAGE_ROOT } from "./members-view";
import { RoleSelect, type AssignableRole } from "./role-select";
import type { AdminMemberDetail, MemberGrantView } from "./types";

/** The estimates and projects a member was added to. */
export interface MemberGrants {
  estimates: MemberGrantView[];
  projects: MemberGrantView[];
}

/** Props for {@link MemberDetailView}. */
export interface MemberDetailViewProps {
  member: AdminMemberDetail;
  /** `undefined` while loading. */
  grants: MemberGrants | undefined;
  onBack: () => void;
  onRoleChange: (role: AssignableRole) => void | Promise<void>;
  onAppAccessChange: (app: AppName, access: AppAccessSetting) => void | Promise<void>;
  onToggleBan: () => void | Promise<void>;
  /** Removes them from the organization. A rejection re-enables the button. */
  onRemoveMember: () => Promise<void>;
  /** Removes them from one estimate (`precision`) or project (`momentum`). */
  onRemoveGrant: (app: AppName, id: string) => void | Promise<void>;
}

/**
 * One member: role and access to each app, the estimates and projects they
 * were added to, and the danger zone.
 *
 * WHY this layout: GitHub/Stripe settings — left-aligned sections with plain
 * headers, inline controls, and the destructive actions last.
 */
export function MemberDetailView({
  member,
  grants,
  onBack,
  onRoleChange,
  onAppAccessChange,
  onToggleBan,
  onRemoveMember,
  onRemoveGrant,
}: MemberDetailViewProps): JSX.Element {
  const [removing, setRemoving] = useState(false);
  const isOwner = member.orgRole === "owner";
  const isAdmin = isOwner || member.orgRole === "admin";
  // An Owner or Admin reaches everything through their role, so empty lists
  // would only raise the question of why. Theirs appear only once loaded and
  // only if something was left over from before they were made an Admin;
  // showing skeletons first would draw two cards that then vanish.
  const showGrants =
    !isAdmin ||
    (grants !== undefined && (grants.estimates.length > 0 || grants.projects.length > 0));

  const handleRemoveMember = () => {
    setRemoving(true);
    onRemoveMember().catch(() => setRemoving(false));
  };

  return (
    <div className={ADMIN_PAGE_ROOT}>
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-body text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Members
      </button>

      <div className="flex items-center gap-4">
        <Avatar className="h-16 w-16">
          {member.image && <AvatarImage src={member.image} alt={member.name} />}
          <AvatarFallback className="text-title3 font-medium">
            {getMemberInitials(member.name)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-title3 font-semibold tracking-tight">{member.name}</h1>
            {member.isBanned && (
              <Badge variant="destructive" className="gap-1 text-footnote">
                <Ban className="h-2.5 w-2.5" />
                Suspended
              </Badge>
            )}
          </div>
          <p className="mt-0.5 truncate text-body text-muted-foreground">{member.email}</p>
          <p className="mt-0.5 text-subheadline text-foreground-subtle">
            Joined {new Date(member.createdAt).toLocaleDateString()}
          </p>
        </div>
      </div>

      <div className="max-w-xl space-y-8">
        <section className="space-y-3">
          <h2 className="text-body font-semibold text-muted-foreground">Role and access</h2>
          <div className="divide-y overflow-hidden rounded-mac-card border bg-card">
            <AccessRow label="Role">
              <RoleSelect
                value={member.orgRole}
                onChange={onRoleChange}
                label="Role"
                variant="field"
              />
            </AccessRow>
            {(["precision", "momentum"] as const).map((app) => (
              <AccessRow key={app} label={APP_NAMES[app]}>
                <AppAccessSelect
                  app={app}
                  value={app === "precision" ? member.precisionAccess : member.momentumAccess}
                  locked={isAdmin}
                  label={`${APP_NAMES[app]} access`}
                  variant="field"
                  onChange={(access) => onAppAccessChange(app, access)}
                />
              </AccessRow>
            ))}
          </div>
        </section>

        {showGrants &&
          (["precision", "momentum"] as const).map((app) => (
            <GrantList
              key={app}
              app={app}
              memberName={member.name}
              appAccess={app === "precision" ? member.precisionAccess : member.momentumAccess}
              items={app === "precision" ? grants?.estimates : grants?.projects}
              onRemove={(id) => onRemoveGrant(app, id)}
            />
          ))}

        {!isOwner && (
          <section className="space-y-3">
            <h2 className="text-body font-semibold text-destructive/70">Danger Zone</h2>
            <div className="space-y-4 rounded-mac-card border border-l-[3px] border-mac-red/20 border-l-mac-red/50 p-5">
              <div className="flex items-center justify-between gap-6">
                <div className="min-w-0">
                  <p className="text-body font-medium">
                    {member.isBanned ? "Reactivate this member" : "Suspend this member"}
                  </p>
                  <p className="mt-0.5 text-subheadline text-muted-foreground">
                    {member.isBanned
                      ? "Restore their access to both apps."
                      : "Block both apps until reactivated."}
                  </p>
                </div>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant={member.isBanned ? "outline" : "destructive"}
                      size="sm"
                      className="shrink-0 gap-1.5"
                    >
                      {member.isBanned ? (
                        <>
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          Reactivate
                        </>
                      ) : (
                        <>
                          <Ban className="h-3.5 w-3.5" />
                          Suspend
                        </>
                      )}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        {member.isBanned ? `Reactivate ${member.name}?` : `Suspend ${member.name}?`}
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        {member.isBanned
                          ? "They get back the access they had."
                          : "They can't open either app until reactivated."}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={() => void onToggleBan()}>
                        {member.isBanned ? "Reactivate" : "Suspend"}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>

              <div className="border-t border-destructive/10" />

              <div className="flex items-center justify-between gap-6">
                <div className="min-w-0">
                  <p className="text-body font-medium">Remove from organization</p>
                  <p className="mt-0.5 text-subheadline text-muted-foreground">
                    They lose access to everything here.
                  </p>
                </div>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="destructive" size="sm" className="shrink-0 gap-1.5">
                      <UserMinus className="h-3.5 w-3.5" />
                      Remove
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Remove {member.name}?</AlertDialogTitle>
                      <AlertDialogDescription>
                        They lose access to everything in this organization. This can&apos;t be
                        undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={handleRemoveMember}
                        disabled={removing}
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      >
                        {removing ? (
                          <>
                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                            Removing...
                          </>
                        ) : (
                          "Remove Member"
                        )}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

/** One labelled control in the Role and access card. */
function AccessRow({ label, children }: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3">
      <p className="text-body font-medium">{label}</p>
      {children}
    </div>
  );
}

/**
 * What removing someone from one item leaves them with, given their app access.
 *
 * WHY it varies: highest wins, so someone set to Can view all still sees the
 * estimate after being removed from it. Saying so stops "I removed them and
 * they can still open it" from looking like a bug.
 */
function removalOutcome(appAccess: EffectiveAppAccess, app: AppName): string {
  const noun = APP_NOUNS[app];
  // Role-neutral: `full` comes from Owner as well as Admin.
  if (appAccess === "full") return "They can still open it: their role gives them full access.";
  if (appAccess === "edit_all") return `They can still edit it: they can edit all ${noun}.`;
  if (appAccess === "view_all") return `They can still view it: they can view all ${noun}.`;
  return "They won't see it anymore.";
}

/** "Estimates" or "Projects": the items a member was added to in one app. */
function GrantList({
  app,
  memberName,
  appAccess,
  items,
  onRemove,
}: {
  app: AppName;
  memberName: string;
  appAccess: EffectiveAppAccess;
  items: MemberGrantView[] | undefined;
  onRemove: (id: string) => void | Promise<void>;
}): JSX.Element {
  const noun = APP_NOUNS[app];
  const heading = noun === "estimates" ? "Estimates" : "Projects";

  return (
    <section className="space-y-3">
      <h2 className="text-body font-semibold text-muted-foreground">{heading}</h2>
      <div className="divide-y overflow-hidden rounded-mac-card border bg-card">
        {items === undefined ? (
          Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-5 py-3">
              <Skeleton className="h-4 w-48" />
            </div>
          ))
        ) : items.length === 0 ? (
          <p className="px-5 py-3 text-subheadline text-muted-foreground">
            Not added to any {noun}.
          </p>
        ) : (
          items.map((item) => {
            const label = item.number ? `${item.number} ${item.name}` : item.name;
            return (
              <div key={item.id} className="flex min-w-0 items-center gap-3 px-5 py-2">
                <p className="min-w-0 flex-1 truncate text-body" title={label}>
                  {item.number && (
                    <span className="mr-2 font-mono text-callout text-muted-foreground tabular-nums">
                      {item.number}
                    </span>
                  )}
                  {item.name}
                </p>
                <span className="shrink-0 text-subheadline text-muted-foreground">
                  {ITEM_LEVEL_LABELS[item.level]}
                </span>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 shrink-0 p-0 text-muted-foreground hover:text-destructive"
                      aria-label={`Remove from ${label}`}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        Remove {memberName} from {label}?
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        {removalOutcome(appAccess, app)}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => void onRemove(item.id)}
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      >
                        Remove
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

/** The member detail page while it loads. */
export function MemberDetailSkeleton(): JSX.Element {
  return (
    <div className={ADMIN_PAGE_ROOT}>
      <Skeleton className="h-5 w-24" />
      <div className="flex items-center gap-4">
        <Skeleton className="h-16 w-16 rounded-full" />
        <div className="space-y-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-56" />
        </div>
      </div>
      <div className="max-w-xl space-y-8">
        <div className="space-y-3">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-24 w-full rounded-lg" />
        </div>
      </div>
    </div>
  );
}
