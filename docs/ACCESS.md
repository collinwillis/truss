# Access: who can see and change what

The design of record for roles and permissions in Precision and Momentum. Adopted 2026-11-03,
replacing four overlapping systems: the organization role, a per-app level that Momentum ignored,
four project roles of which only "viewer" did anything, and WBS/phase scoping that nobody outside
the admins used.

It follows the shape the best products share (OpenAI's API platform, ChatGPT workspaces, Notion,
Figma, Vercel, Procore): **one role per person, plus access granted per item.**

## The model

### 1. Role (one per person, per organization)

| Role   | Means                                                                                 |
| ------ | ------------------------------------------------------------------------------------- |
| Owner  | Full access to everything. Exactly one. Cannot be changed or removed from the app.    |
| Admin  | Full access to everything: people, rate books, project settings, reports, every item. |
| Member | Exactly what their app access (below) and the items they have been added to allow.    |

Stored as Better Auth `member.role` (`owner` / `admin` / `member`). Owners and admins can set
another person's role to Admin or Member, never Owner.

### 2. App access (one setting per Member, per app)

| Value      | Label         | Precision                                                   | Momentum                               |
| ---------- | ------------- | ----------------------------------------------------------- | -------------------------------------- |
| `none`     | No access     | Cannot open Precision (access wall).                        | Cannot open Momentum (access wall).    |
| `assigned` | Only assigned | Sees only estimates they were added to; can start new ones. | Sees only projects they were added to. |
| `view_all` | Can view all  | Opens every estimate; changes nothing.                      | Opens every project read-only.         |
| `edit_all` | Can edit all  | Works on every estimate.                                    | Logs and edits on every project.       |

Owners and Admins have no app setting: they show as **Full access**, locked. A member with no stored
setting has **No access** in Precision and **Only assigned** in Momentum, which is exactly what a
new sign-up gets today: Precision shows its access wall, and Momentum shows no projects until
someone adds them to one. Adding someone to an estimate or project lifts that app from `none` to
`assigned` automatically, so "add them to the job" is one step.

Stored on `appPermissions.access`. The legacy `appPermissions.permission` (`none|read|write|admin`)
is read only as a fallback when `access` is unset (see Migration).

### 3. Item access (per estimate, per project)

Owners and Admins add a person to one estimate or one project as **Can view** or **Can edit**.
Stored in `accessGrants` (`userId`, `proposalId` or `projectId`, `level: view|edit`).

### Resolving one person's access to one item

```
role owner/admin                → full
app access none                 → no access (grants are ignored until it is lifted)
otherwise the highest of:
  app access edit_all → edit,  view_all → view,  assigned → nothing on its own
  the item's grant for them → its level
banned or not a member          → no access, always
```

Highest wins, like OpenAI's "access is the union" and Notion's "higher level wins".

## What each level can do

**Precision**

| Action                                            | Needs                                                                             |
| ------------------------------------------------- | --------------------------------------------------------------------------------- |
| Open Precision, browse the published rate catalog | app access other than `none`                                                      |
| Read a rate book's pools while estimating         | app access other than `none`; a draft book: Owner or Admin                        |
| See an estimate in the list, open it, export it   | view on that estimate                                                             |
| Edit, revise, duplicate, change status, delete    | edit on that estimate                                                             |
| Start a new estimate                              | full, `edit_all`, or `assigned` (creator gets edit on it; `createdBy` is stamped) |
| Create a revision of an estimate                  | may start a new estimate, and view on the source                                  |
| Rate books, draft catalogs, members, sharing      | Owner or Admin                                                                    |

**Momentum**

| Action                                                                       | Needs                |
| ---------------------------------------------------------------------------- | -------------------- |
| See a project, its workbook, its history                                     | view on that project |
| Log and correct progress, add/edit/move activities and phases, change orders | edit on that project |
| Create or delete projects, project settings, people, reports                 | Owner or Admin       |

There is no WBS or phase scoping: access is to a whole project.

## Screens

- **Members** (shared admin page, both apps): Name, Role, Precision, Momentum. Owner/Admin rows show
  "Full access" locked. Member rows get a select: No access / Only assigned / Can view all / Can
  edit all. The member detail page lists the estimates and projects they have been added to.
- **Share** (Precision, on an estimate, Owner/Admin only): add people as Can view / Can edit, change
  or remove them, and a muted summary of who has access through their role or app access.
- **People** (Momentum, project settings, Owner/Admin only): the same panel for a project.

## Compatibility with installed apps

Momentum ≤ 0.1.13 and Precision ≤ 0.1.4 stay installed until people update, so the server keeps
their calls working:

- `appPermissions.getMemberPermissions` returns legacy levels derived from the new model:
  Owner/Admin → `admin`; `edit_all` → `write`; `view_all` → `read`; `assigned` → `write` if they can
  edit any item in that app, `read` if they can view any, else `none`; `none` → `none`.
- `appPermissions.setPermission` maps legacy writes: Precision `none/read/write` →
  `none/view_all/edit_all`; Momentum `none/read/write` → `assigned`; `admin` is refused with "Make
  them an Admin from the Role column instead."
- `adminUsers.listOrganizationMembers` keeps its legacy permission fields (derived) and adds the new
  ones.
- The `projectAssignments` functions keep working on their legacy table for old Team screens.
  Project-scope legacy rows count as grants (`viewer` → view, any other role → edit);
  WBS/phase-scoped rows grant nothing, and assigning one is refused. Every write there brings the
  person's grant on that project in step with their remaining project-scope rows, so removing
  someone on an old Team screen still removes their access after the migration. People added only
  through the new People panel do not appear on old Team screens.
- `getMemberPermissions` answers `none` for both apps to a suspended caller instead of refusing, so
  an old client shows its access wall rather than an error.
- `getBrowseData().scopeInfo` keeps `hasAccess`, `isScoped` and `effectiveRole` (`viewer` for view,
  `superintendent` otherwise) and adds `access: "full" | "edit" | "view"`.

## Migration

Deploying changes nobody's access: the resolver reads the legacy `permission` value when `access` is
unset, and counts legacy project-scope assignments as grants. Legacy Precision `read` → `view_all`,
`write`/`admin` → `edit_all`, `none` or no row → `none`; any legacy Momentum value or no row →
`assigned` (Momentum's levels never did anything on the server; only assignments did). Legacy
app-level `admin` on someone who is not an org Owner/Admin no longer makes them an admin; in
production every such grant belongs to an org admin, so nobody loses anything.

`access:migrateToSimpleAccess` (internal, idempotent, run once by hand with approval) writes
`access` on every `appPermissions` row, deletes rows belonging to Owners/Admins, and copies
effective legacy assignments into `accessGrants`. A later change removes the legacy fallbacks and
the `projectAssignments` table once installed apps have updated.
