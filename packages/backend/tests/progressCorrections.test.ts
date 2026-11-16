/// <reference types="vite/client" />
// @vitest-environment edge-runtime

/**
 * Correcting progress that was already logged: moving a day to the right date,
 * fixing a number, and the record of both.
 *
 * Momentum's logs are mostly typed from paper days after the work, so both
 * corrections are common. What these guard is that a correction is SAFE: a
 * move never changes a project total, an undo puts everything back exactly,
 * fixing a number keeps its note and records what it was, and nobody who can
 * only view a project can change it. Access is to a whole project
 * (docs/ACCESS.md), so anyone who can edit it may correct any line on it.
 */
import { describe, expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { CORRECTION_REFUSED } from "../convex/momentum";
import {
  combineNotes,
  isEntryDate,
  latestEntryDate,
  noteAfterSave,
} from "../convex/model/progressCorrections";
import { authHarness, seedOrganization, seedPrincipal } from "./authFixtures";
import { seedProposal, type TestRunner } from "./convexFixtures";

// ============================================================================
// The rules, without a database
// ============================================================================

describe("isEntryDate", () => {
  it("accepts only real calendar days", () => {
    expect(isEntryDate("2026-10-28")).toBe(true);
    expect(isEntryDate("2024-02-29")).toBe(true);
    expect(isEntryDate("2026-02-30")).toBe(false);
    expect(isEntryDate("2026-1-5")).toBe(false);
    expect(isEntryDate("Oct 28")).toBe(false);
    expect(isEntryDate("")).toBe(false);
  });
});

describe("latestEntryDate", () => {
  it("allows one day of slack past UTC today, for clocks behind or ahead of it", () => {
    expect(latestEntryDate(Date.parse("2026-11-03T23:30:00Z"))).toBe("2026-11-04");
  });
});

describe("combineNotes", () => {
  it("keeps both halves' notes, once each", () => {
    expect(combineNotes("Rained at 2", "Crane down")).toBe("Rained at 2 · Crane down");
    expect(combineNotes("Same", "Same")).toBe("Same");
    expect(combineNotes(undefined, " ")).toBeUndefined();
    expect(combineNotes(undefined, "Only one")).toBe("Only one");
  });
});

describe("noteAfterSave", () => {
  it("keeps the note when only the quantity was corrected", () => {
    expect(noteAfterSave({ sent: undefined, existing: "Crane down", quantityChanged: true })).toBe(
      "Crane down"
    );
  });

  it("clears it when an installed client saves the note empty", () => {
    // Momentum 0.1.12 sends no note to clear one, with the quantity unchanged.
    expect(
      noteAfterSave({ sent: undefined, existing: "Crane down", quantityChanged: false })
    ).toBeUndefined();
  });

  it("takes a note that was sent, and an empty one clears", () => {
    expect(noteAfterSave({ sent: "New", existing: "Old", quantityChanged: false })).toBe("New");
    expect(noteAfterSave({ sent: " ", existing: "Old", quantityChanged: false })).toBeUndefined();
  });
});

// ============================================================================
// A job to correct
// ============================================================================

const OCT_27 = "2026-10-27";
const OCT_28 = "2026-10-28";
const OCT_29 = "2026-10-29";

interface Job {
  t: TestRunner;
  admin: Awaited<ReturnType<typeof seedPrincipal>>;
  foreman: Awaited<ReturnType<typeof seedPrincipal>>;
  viewer: Awaited<ReturnType<typeof seedPrincipal>>;
  /** A member who was never added to the job. */
  outsider: Awaited<ReturnType<typeof seedPrincipal>>;
  projectId: Id<"momentumProjects">;
  phaseA: Id<"momentumPhases">;
  phaseB: Id<"momentumPhases">;
  /** 3" pipe in phase A, 1,000 LF, with 100 LF of it split into phase B. */
  pipe: Id<"momentumActivities">;
  pipeSplit: Id<"activitySplits">;
  /** Gate valves in phase A, 20 EA. */
  valve: Id<"momentumActivities">;
  /** Supports in phase B, 50 EA. */
  support: Id<"momentumActivities">;
}

/**
 * An admin, a foreman and a viewer on the job through legacy project-scope
 * rows (the shape production's field members have), a member who is not on
 * it, and one job with two phases.
 */
async function seedJob(): Promise<Job> {
  const t = authHarness();
  const organizationId = await seedOrganization(t, "indemand");
  const admin = await seedPrincipal(t, {
    organizationId,
    role: "owner",
    email: "matt@indemand.test",
  });
  const foreman = await seedPrincipal(t, {
    organizationId,
    role: "member",
    email: "foreman@indemand.test",
  });
  const viewer = await seedPrincipal(t, {
    organizationId,
    role: "member",
    email: "viewer@indemand.test",
  });
  const outsider = await seedPrincipal(t, {
    organizationId,
    role: "member",
    email: "outsider@indemand.test",
  });
  const tree = await seedProposal(t, { proposalNumber: "2124" });

  const ids = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("momentumProjects", {
      proposalId: tree.proposalId,
      name: "AG piping",
      proposalNumber: "2124",
      ownerName: "Test Owner",
      status: "active" as const,
    });
    const wbsId = await ctx.db.insert("momentumWbs", {
      projectId,
      name: "AG PIPING",
      sortOrder: 1,
      source: "estimate" as const,
    });
    const phase = (phaseNumber: number, description: string) =>
      ctx.db.insert("momentumPhases", {
        projectId,
        wbsId,
        poolName: "CARBON STEEL",
        phaseNumber,
        description,
        isCompleted: false,
        sortOrder: phaseNumber,
        source: "estimate" as const,
      });
    const phaseA = await phase(70001, "Pipe rack");
    const phaseB = await phase(70002, "Tank farm");
    const activity = (
      phaseId: Id<"momentumPhases">,
      description: string,
      quantity: number,
      unit: string
    ) =>
      ctx.db.insert("momentumActivities", {
        projectId,
        wbsId,
        phaseId,
        type: "labor" as const,
        description,
        quantity,
        unit,
        sortOrder: 1,
        source: "estimate" as const,
      });
    const pipe = await activity(phaseA, '3" CS pipe', 1000, "LF");
    const valve = await activity(phaseA, '3" gate valve', 20, "EA");
    const support = await activity(phaseB, "Pipe supports", 50, "EA");
    const pipeSplit = await ctx.db.insert("activitySplits", {
      projectId,
      sourceActivityId: pipe,
      targetPhaseId: phaseB,
      targetWbsId: wbsId,
      quantity: 100,
      createdAt: Date.now(),
    });
    await ctx.db.insert("projectAssignments", {
      projectId,
      userId: foreman.userId,
      scopeType: "project" as const,
      role: "foreman" as const,
      assignedAt: Date.now(),
    });
    await ctx.db.insert("projectAssignments", {
      projectId,
      userId: viewer.userId,
      scopeType: "project" as const,
      role: "viewer" as const,
      assignedAt: Date.now(),
    });
    return { projectId, phaseA, phaseB, pipe, pipeSplit, valve, support };
  });

  return { t, admin, foreman, viewer, outsider, ...ids };
}

type Caller = Job["admin"]["as"];

/** Log numbers for one day, the way the workbook saves them. */
async function log(
  as: Caller,
  job: Job,
  entryDate: string,
  entries: Array<{
    activityId: Id<"momentumActivities">;
    quantityCompleted: number;
    notes?: string;
    splitId?: Id<"activitySplits">;
  }>
): Promise<void> {
  await as.mutation(api.momentum.saveProgressEntries, {
    projectId: job.projectId,
    entryDate,
    entries,
  });
}

/** Every stored entry, flattened to what a test compares. */
async function stored(job: Job) {
  return await job.t.run(async (ctx) => {
    const rows = await ctx.db
      .query("progressEntries")
      .withIndex("by_project_date", (q) => q.eq("projectId", job.projectId))
      .collect();
    return rows
      .map((row) => ({
        date: row.entryDate,
        activity: row.newActivityId as string,
        split: (row.splitId as string | undefined) ?? null,
        quantity: row.quantityCompleted,
        notes: row.notes ?? null,
        enteredBy: row.enteredBy ?? null,
        phase: (row.newPhaseId as string | undefined) ?? null,
      }))
      .sort((a, b) =>
        `${a.date}${a.activity}${a.split}`.localeCompare(`${b.date}${b.activity}${b.split}`)
      );
  });
}

/** Total logged per line, across every day: what no move may ever change. */
async function totals(job: Job): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const row of await stored(job)) {
    const key = row.split ? `${row.activity}|${row.split}` : row.activity;
    result[key] = Math.round(((result[key] ?? 0) + row.quantity) * 100) / 100;
  }
  return result;
}

async function lastEntryDate(job: Job): Promise<string | null> {
  return await job.t.run(async (ctx) => (await ctx.db.get(job.projectId))?.lastEntryDate ?? null);
}

// ============================================================================
// Fixing a number
// ============================================================================

describe("saveProgressEntries, correcting a day", () => {
  it("keeps a line's note when its number is corrected", async () => {
    const job = await seedJob();
    await log(job.admin.as, job, OCT_28, [
      { activityId: job.valve, quantityCompleted: 8, notes: "Two were rework" },
    ]);
    // The workbook saves a typed number with no note.
    await log(job.admin.as, job, OCT_28, [{ activityId: job.valve, quantityCompleted: 6 }]);

    const [row] = await stored(job);
    expect(row).toMatchObject({ quantity: 6, notes: "Two were rework" });
  });

  it("still lets an installed client clear a note", async () => {
    const job = await seedJob();
    await log(job.admin.as, job, OCT_28, [
      { activityId: job.valve, quantityCompleted: 8, notes: "Two were rework" },
    ]);
    // Momentum 0.1.12 clears a note by saving the same number with no note.
    await log(job.admin.as, job, OCT_28, [{ activityId: job.valve, quantityCompleted: 8 }]);
    expect((await stored(job))[0]?.notes).toBeNull();
  });

  it("records what every number was, and records nothing for a note", async () => {
    const job = await seedJob();
    await log(job.admin.as, job, OCT_28, [{ activityId: job.valve, quantityCompleted: 8 }]);
    await log(job.admin.as, job, OCT_28, [{ activityId: job.valve, quantityCompleted: 6 }]);
    await log(job.admin.as, job, OCT_28, [
      { activityId: job.valve, quantityCompleted: 6, notes: "Checked" },
    ]);
    await log(job.admin.as, job, OCT_28, [{ activityId: job.valve, quantityCompleted: 0 }]);

    const history = await job.admin.as.query(api.momentum.getCellHistory, {
      projectId: job.projectId,
      activityId: job.valve,
      entryDate: OCT_28,
    });
    expect(history?.current).toBeNull();
    expect(
      history?.changes.map((c) => [c.kind, c.before ?? null, c.after ?? null, c.byName])
    ).toEqual([
      ["edit", 6, null, "matt@indemand.test"],
      ["edit", 8, 6, "matt@indemand.test"],
      ["edit", null, 8, "matt@indemand.test"],
    ]);
  });

  it("does not move the project's last update backward when an old day is fixed", async () => {
    const job = await seedJob();
    await log(job.admin.as, job, OCT_29, [{ activityId: job.valve, quantityCompleted: 2 }]);
    await log(job.admin.as, job, OCT_27, [{ activityId: job.valve, quantityCompleted: 3 }]);
    expect(await lastEntryDate(job)).toBe(OCT_29);
  });

  it("refuses to let a viewer erase a number by saving 0", async () => {
    // Saving 0 DELETES the day's number, so it needs edit like any save.
    const job = await seedJob();
    await log(job.admin.as, job, OCT_28, [{ activityId: job.support, quantityCompleted: 5 }]);
    await expect(
      log(job.viewer.as, job, OCT_28, [{ activityId: job.support, quantityCompleted: 0 }])
    ).rejects.toThrow(/view this project but not edit it/);
    expect((await stored(job))[0]?.quantity).toBe(5);
  });

  it("refuses a line from another project, and writes nothing", async () => {
    // The edit check is the project's; a line from elsewhere must not ride it.
    const job = await seedJob();
    const elsewhere = await job.t.run(async (ctx) => {
      const project = await ctx.db.get(job.projectId);
      if (!project) throw new Error("fixture: no project");
      const projectId = await ctx.db.insert("momentumProjects", {
        proposalId: project.proposalId,
        name: "Other job",
        proposalNumber: "2125",
        ownerName: "Test Owner",
        status: "active" as const,
      });
      const wbsId = await ctx.db.insert("momentumWbs", {
        projectId,
        name: "AG PIPING",
        sortOrder: 1,
        source: "estimate" as const,
      });
      const phaseId = await ctx.db.insert("momentumPhases", {
        projectId,
        wbsId,
        poolName: "CARBON STEEL",
        phaseNumber: 70001,
        description: "Pipe rack",
        isCompleted: false,
        sortOrder: 1,
        source: "estimate" as const,
      });
      return ctx.db.insert("momentumActivities", {
        projectId,
        wbsId,
        phaseId,
        type: "labor" as const,
        description: "Elsewhere",
        quantity: 10,
        unit: "EA",
        sortOrder: 1,
        source: "estimate" as const,
      });
    });

    await expect(
      log(job.admin.as, job, OCT_28, [
        { activityId: job.valve, quantityCompleted: 1 },
        { activityId: elsewhere, quantityCompleted: 1 },
      ])
    ).rejects.toThrow(/not part of this project/);
    expect(await stored(job)).toEqual([]);
  });

  it("refuses a date that is not a day, and a negative number", async () => {
    const job = await seedJob();
    await expect(
      log(job.admin.as, job, "2026-02-30", [{ activityId: job.valve, quantityCompleted: 1 }])
    ).rejects.toThrow(/not a day/);
    await log(job.admin.as, job, OCT_28, [{ activityId: job.valve, quantityCompleted: 4 }]);
    await expect(
      log(job.admin.as, job, OCT_28, [{ activityId: job.valve, quantityCompleted: -2 }])
    ).rejects.toThrow(/negative/);
  });
});

// ============================================================================
// Moving a day
// ============================================================================

describe("moveEntriesToDate", () => {
  it("re-dates a day and changes nothing else about it", async () => {
    const job = await seedJob();
    await log(job.admin.as, job, OCT_28, [
      { activityId: job.pipe, quantityCompleted: 120, notes: "Rack 3" },
      { activityId: job.valve, quantityCompleted: 4 },
    ]);
    const before = await totals(job);

    const result = await job.admin.as.mutation(api.momentum.moveEntriesToDate, {
      projectId: job.projectId,
      fromDate: OCT_28,
      toDate: OCT_29,
    });

    expect(result).toMatchObject({ moved: 2, combined: 0 });
    const rows = await stored(job);
    expect(rows.every((row) => row.date === OCT_29)).toBe(true);
    expect(rows.find((row) => row.activity === job.pipe)).toMatchObject({
      quantity: 120,
      notes: "Rack 3",
      enteredBy: "matt@indemand.test",
      phase: job.phaseA,
    });
    expect(await totals(job)).toEqual(before);
  });

  it("adds a moved number to one already on the other day, and keeps both notes", async () => {
    const job = await seedJob();
    await log(job.admin.as, job, OCT_28, [
      { activityId: job.valve, quantityCompleted: 4, notes: "North rack" },
    ]);
    await log(job.admin.as, job, OCT_29, [
      { activityId: job.valve, quantityCompleted: 2, notes: "South rack" },
    ]);
    const before = await totals(job);

    const result = await job.admin.as.mutation(api.momentum.moveEntriesToDate, {
      projectId: job.projectId,
      fromDate: OCT_28,
      toDate: OCT_29,
    });

    expect(result).toMatchObject({ moved: 1, combined: 1 });
    // ONE row for the day, not two: two rows for one line would show one number
    // in the cell while every total counted both.
    expect(await stored(job)).toEqual([
      expect.objectContaining({ date: OCT_29, quantity: 6, notes: "South rack · North rack" }),
    ]);
    expect(await totals(job)).toEqual(before);
  });

  it("never adds a split row's number to its source activity's", async () => {
    const job = await seedJob();
    await log(job.admin.as, job, OCT_28, [
      { activityId: job.pipe, quantityCompleted: 30, splitId: job.pipeSplit },
    ]);
    await log(job.admin.as, job, OCT_29, [{ activityId: job.pipe, quantityCompleted: 50 }]);

    await job.admin.as.mutation(api.momentum.moveEntriesToDate, {
      projectId: job.projectId,
      fromDate: OCT_28,
      toDate: OCT_29,
    });

    const rows = await stored(job);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.split === job.pipeSplit)).toMatchObject({
      quantity: 30,
      phase: job.phaseB,
    });
    expect(rows.find((row) => row.split === null)).toMatchObject({ quantity: 50 });
  });

  it("moves only the lines that were picked", async () => {
    const job = await seedJob();
    await log(job.admin.as, job, OCT_28, [
      { activityId: job.pipe, quantityCompleted: 120 },
      { activityId: job.valve, quantityCompleted: 4 },
    ]);

    await job.admin.as.mutation(api.momentum.moveEntriesToDate, {
      projectId: job.projectId,
      fromDate: OCT_28,
      toDate: OCT_29,
      rows: [{ activityId: job.valve }],
    });

    const rows = await stored(job);
    expect(rows.find((row) => row.activity === job.valve)?.date).toBe(OCT_29);
    expect(rows.find((row) => row.activity === job.pipe)?.date).toBe(OCT_28);
  });

  it("moves every line on the day for a foreman, because access is to the whole project", async () => {
    const job = await seedJob();
    await log(job.admin.as, job, OCT_28, [
      { activityId: job.valve, quantityCompleted: 4 },
      { activityId: job.support, quantityCompleted: 7 },
    ]);

    const result = await job.foreman.as.mutation(api.momentum.moveEntriesToDate, {
      projectId: job.projectId,
      fromDate: OCT_28,
      toDate: OCT_29,
    });
    expect(result.moved).toBe(2);
    const rows = await stored(job);
    expect(rows.every((row) => row.date === OCT_29)).toBe(true);
  });

  it("refuses a member who is not on the project, and moves nothing", async () => {
    const job = await seedJob();
    await log(job.admin.as, job, OCT_28, [{ activityId: job.valve, quantityCompleted: 4 }]);
    await expect(
      job.outsider.as.mutation(api.momentum.moveEntriesToDate, {
        projectId: job.projectId,
        fromDate: OCT_28,
        toDate: OCT_29,
      })
    ).rejects.toThrow(/do not have access to this project/);
    expect((await stored(job))[0]?.date).toBe(OCT_28);
  });

  it("moves a line already past its estimate, because a move cannot change a total", async () => {
    const job = await seedJob();
    await log(job.admin.as, job, OCT_28, [{ activityId: job.valve, quantityCompleted: 20 }]);
    // The estimate is revised down after the work was logged.
    await job.t.run(async (ctx) => {
      await ctx.db.patch(job.valve, { quantity: 12 });
    });

    const result = await job.admin.as.mutation(api.momentum.moveEntriesToDate, {
      projectId: job.projectId,
      fromDate: OCT_28,
      toDate: OCT_29,
    });
    expect(result.moved).toBe(1);
  });

  it("points the project's last update at the newest day that still has progress", async () => {
    const job = await seedJob();
    await log(job.admin.as, job, OCT_27, [{ activityId: job.pipe, quantityCompleted: 10 }]);
    await log(job.admin.as, job, OCT_29, [{ activityId: job.valve, quantityCompleted: 2 }]);
    await job.admin.as.mutation(api.momentum.moveEntriesToDate, {
      projectId: job.projectId,
      fromDate: OCT_29,
      toDate: OCT_28,
    });
    expect(await lastEntryDate(job)).toBe(OCT_28);
  });

  it("refuses the same day, a day that hasn't happened, an empty day, and a viewer", async () => {
    const job = await seedJob();
    await log(job.admin.as, job, OCT_28, [{ activityId: job.valve, quantityCompleted: 4 }]);
    const move = (as: Caller, fromDate: string, toDate: string) =>
      as.mutation(api.momentum.moveEntriesToDate, { projectId: job.projectId, fromDate, toDate });

    await expect(move(job.admin.as, OCT_28, OCT_28)).rejects.toThrow(/different day/);
    await expect(move(job.admin.as, OCT_28, "2099-01-04")).rejects.toThrow(/hasn't happened/);
    await expect(move(job.admin.as, OCT_27, OCT_29)).rejects.toThrow(/nothing on that day/);
    await expect(move(job.viewer.as, OCT_28, OCT_29)).rejects.toThrow(/not edit it/);
  });
});

// ============================================================================
// Undoing a move
// ============================================================================

describe("undoMoveEntries", () => {
  it("puts a move back exactly, including numbers it was added to", async () => {
    const job = await seedJob();
    await log(job.admin.as, job, OCT_28, [
      { activityId: job.valve, quantityCompleted: 4, notes: "North rack" },
      { activityId: job.pipe, quantityCompleted: 120 },
    ]);
    await log(job.foreman.as, job, OCT_29, [
      { activityId: job.valve, quantityCompleted: 2, notes: "South rack" },
    ]);
    const before = await stored(job);

    const { moveId } = await job.admin.as.mutation(api.momentum.moveEntriesToDate, {
      projectId: job.projectId,
      fromDate: OCT_28,
      toDate: OCT_29,
    });
    const undone = await job.admin.as.mutation(api.momentum.undoMoveEntries, { moveId });

    expect(undone).toEqual({ fromDate: OCT_28, toDate: OCT_29 });
    expect(await stored(job)).toEqual(before);
    await expect(job.admin.as.mutation(api.momentum.undoMoveEntries, { moveId })).rejects.toThrow(
      /already been undone/
    );
  });

  it("refuses, and writes nothing, once the day it was moved to has changed", async () => {
    const job = await seedJob();
    await log(job.admin.as, job, OCT_28, [
      { activityId: job.valve, quantityCompleted: 4 },
      { activityId: job.pipe, quantityCompleted: 120 },
    ]);
    const { moveId } = await job.admin.as.mutation(api.momentum.moveEntriesToDate, {
      projectId: job.projectId,
      fromDate: OCT_28,
      toDate: OCT_29,
    });
    await log(job.admin.as, job, OCT_29, [{ activityId: job.valve, quantityCompleted: 5 }]);
    const afterEdit = await stored(job);

    // A kind on the data, because production redacts a plain error's sentence.
    await expect(
      job.admin.as.mutation(api.momentum.undoMoveEntries, { moveId })
    ).rejects.toMatchObject({
      data: { kind: CORRECTION_REFUSED, message: expect.stringMatching(/changed since/) },
    });
    expect(await stored(job)).toEqual(afterEdit);
  });

  it("refuses once a combined day's note has been edited, rather than lose the edit", async () => {
    const job = await seedJob();
    await log(job.admin.as, job, OCT_28, [
      { activityId: job.valve, quantityCompleted: 4, notes: "North rack" },
    ]);
    await log(job.admin.as, job, OCT_29, [
      { activityId: job.valve, quantityCompleted: 2, notes: "South rack" },
    ]);
    const { moveId } = await job.admin.as.mutation(api.momentum.moveEntriesToDate, {
      projectId: job.projectId,
      fromDate: OCT_28,
      toDate: OCT_29,
    });
    // Same number, new note: only the note says the day changed.
    await log(job.admin.as, job, OCT_29, [
      { activityId: job.valve, quantityCompleted: 6, notes: "4 of these were Tuesday's" },
    ]);
    const afterEdit = await stored(job);

    await expect(job.admin.as.mutation(api.momentum.undoMoveEntries, { moveId })).rejects.toThrow(
      /changed since/
    );
    expect(await stored(job)).toEqual(afterEdit);
  });

  it("refuses once the original day has new progress for a moved line", async () => {
    const job = await seedJob();
    await log(job.admin.as, job, OCT_28, [{ activityId: job.valve, quantityCompleted: 4 }]);
    const { moveId } = await job.admin.as.mutation(api.momentum.moveEntriesToDate, {
      projectId: job.projectId,
      fromDate: OCT_28,
      toDate: OCT_29,
    });
    await log(job.admin.as, job, OCT_28, [{ activityId: job.valve, quantityCompleted: 1 }]);
    await expect(job.admin.as.mutation(api.momentum.undoMoveEntries, { moveId })).rejects.toThrow(
      /original day/
    );
  });

  it("shows the move and its undo in the line's history", async () => {
    const job = await seedJob();
    await log(job.admin.as, job, OCT_28, [{ activityId: job.valve, quantityCompleted: 4 }]);
    const { moveId } = await job.admin.as.mutation(api.momentum.moveEntriesToDate, {
      projectId: job.projectId,
      fromDate: OCT_28,
      toDate: OCT_29,
    });
    await job.admin.as.mutation(api.momentum.undoMoveEntries, { moveId });

    const history = await job.admin.as.query(api.momentum.getCellHistory, {
      projectId: job.projectId,
      activityId: job.valve,
      entryDate: OCT_28,
    });
    expect(history?.current?.quantity).toBe(4);
    expect(history?.changes.map((c) => [c.kind, c.otherDate ?? null])).toEqual([
      ["undo", OCT_29],
      ["move_out", OCT_29],
      ["edit", null],
    ]);
  });
});

// ============================================================================
// Finding the day to fix
// ============================================================================

describe("reading a day and its history", () => {
  it("gives everyone who can see the project every number for a day, and others none", async () => {
    const job = await seedJob();
    await log(job.admin.as, job, OCT_28, [
      { activityId: job.valve, quantityCompleted: 4 },
      { activityId: job.support, quantityCompleted: 7 },
    ]);
    const dayFor = (as: Caller) =>
      as.query(api.momentum.getEntriesForDate, { projectId: job.projectId, entryDate: OCT_28 });

    const everyLine = [job.valve, job.support].sort();
    expect(Object.keys(await dayFor(job.foreman.as)).sort()).toEqual(everyLine);
    expect(Object.keys(await dayFor(job.viewer.as)).sort()).toEqual(everyLine);
    expect(await dayFor(job.outsider.as)).toEqual({});
  });

  it("opens History to anyone who can see the project, newest days first", async () => {
    const job = await seedJob();
    await log(job.admin.as, job, OCT_27, [{ activityId: job.valve, quantityCompleted: 1 }]);
    await log(job.admin.as, job, OCT_29, [
      { activityId: job.valve, quantityCompleted: 2 },
      { activityId: job.support, quantityCompleted: 7 },
    ]);
    await log(job.admin.as, job, OCT_28, [{ activityId: job.valve, quantityCompleted: 3 }]);

    const history = await job.foreman.as.query(api.momentum.getEntryHistory, {
      projectId: job.projectId,
    });
    expect(history?.days.map((day) => day.date)).toEqual([OCT_29, OCT_28, OCT_27]);
    expect(history?.days[0]?.entries.map((entry) => entry.rowKey).sort()).toEqual(
      [job.valve, job.support].sort()
    );

    // Can view is enough to read it; not being on the project is not.
    const viewed = await job.viewer.as.query(api.momentum.getEntryHistory, {
      projectId: job.projectId,
    });
    expect(viewed?.days.map((day) => day.date)).toEqual([OCT_29, OCT_28, OCT_27]);
    expect(
      await job.outsider.as.query(api.momentum.getEntryHistory, { projectId: job.projectId })
    ).toBeNull();
  });

  it("never stops History halfway through a day", async () => {
    const job = await seedJob();
    await log(job.admin.as, job, OCT_29, [
      { activityId: job.valve, quantityCompleted: 2 },
      { activityId: job.pipe, quantityCompleted: 40 },
    ]);
    await log(job.admin.as, job, OCT_28, [{ activityId: job.valve, quantityCompleted: 3 }]);

    const history = await job.admin.as.query(api.momentum.getEntryHistory, {
      projectId: job.projectId,
      limit: 1,
    });
    expect(history?.days.map((day) => [day.date, day.entryCount])).toEqual([[OCT_29, 2]]);
    expect(history?.hasMore).toBe(true);
  });

  it("answers null, not an error, for a split that is gone or not the line's", async () => {
    const job = await seedJob();
    expect(
      await job.foreman.as.query(api.momentum.getCellHistory, {
        projectId: job.projectId,
        activityId: job.valve,
        splitId: job.pipeSplit,
        entryDate: OCT_28,
      })
    ).toBeNull();
    await job.t.run(async (ctx) => ctx.db.delete(job.pipeSplit));
    expect(
      await job.foreman.as.query(api.momentum.getCellHistory, {
        projectId: job.projectId,
        activityId: job.pipe,
        splitId: job.pipeSplit,
        entryDate: OCT_28,
      })
    ).toBeNull();
  });

  it("shows a line's history to a viewer, and keeps it from someone not on the project", async () => {
    const job = await seedJob();
    await log(job.admin.as, job, OCT_28, [{ activityId: job.support, quantityCompleted: 7 }]);
    const historyFor = (as: Caller) =>
      as.query(api.momentum.getCellHistory, {
        projectId: job.projectId,
        activityId: job.support,
        entryDate: OCT_28,
      });

    expect((await historyFor(job.viewer.as))?.current?.quantity).toBe(7);
    expect(await historyFor(job.outsider.as)).toBeNull();
  });
});
