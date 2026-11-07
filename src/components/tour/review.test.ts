import { beforeAll, describe, expect, it, vi } from "vitest";

// The tour's actions read the login from the request headers and use the app database: both are stood in for.
const state = vi.hoisted(() => ({ headers: new Headers(), db: null as unknown }));
vi.mock("next/headers", () => ({ headers: async () => state.headers }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/db")>();
  return { ...real, getDb: () => state.db };
});

import { eq } from "drizzle-orm";
import { openTestDb, type Db } from "@/lib/db";
import { obligations } from "@/lib/db/schema";
import { seedDemo } from "@/lib/demo/seed";
import { ACTOR_HEADER, ROLE_HEADER } from "@/lib/basicAuth";
import { cancelWindowMinutesField, cancelWindowText } from "../cancel-window";
import { tourAutopilotAction } from "./actions";
import { autopilotMessage } from "./messages";
import { copyStamp, move, outlivedCopy, parseTourCookie, tourCookieValue } from "./steps";

describe("tour progress belongs to the copy it was taken in", () => {
  it("keeps the copy in the cookie and through Next and Back", () => {
    const s = parseTourCookie("4.abc123");
    expect(s).toEqual({ status: "on", index: 4, copy: "abc123" });
    expect(tourCookieValue(s)).toBe("4.abc123");
    expect(move(s, 1)).toEqual({ status: "on", index: 5, copy: "abc123" });
    expect(parseTourCookie("4.ABC!")).toEqual({ status: "off" });
  });

  it("notices a fresh copy under a later step, and only then", () => {
    const at5 = { status: "on" as const, index: 4, copy: "old" };
    expect(outlivedCopy(at5, "new")).toBe(true);
    expect(outlivedCopy(at5, "old")).toBe(false);
    expect(outlivedCopy({ status: "on", index: 0, copy: "old" }, "new")).toBe(false); // step 1 has nothing to lose
    expect(outlivedCopy({ status: "on", index: 4 }, "new")).toBe(false); // not stamped yet: it takes the current one
    expect(outlivedCopy({ status: "done" }, "new")).toBe(false);
  });

  it("stamps a copy by when it was made and when its demo was seeded", () => {
    const seeded = "2026-11-01T00:00:00.000Z";
    expect(copyStamp(1000, seeded)).toMatch(/^[a-z0-9]+$/);
    expect(copyStamp(1000, seeded)).not.toBe(copyStamp(2000, seeded)); // Start over: same template, new copy
    expect(copyStamp(null, seeded)).not.toBe(copyStamp(null, "2026-11-02T00:00:00.000Z")); // shared demo reset
    expect(copyStamp(null, null)).toBeNull();
  });
});

describe("the cancel window in words", () => {
  it("never reads 0 minutes, and the field starts at a value Settings accepts", () => {
    expect(cancelWindowText(20)).toBe("20 seconds (shortened for the tour)");
    expect(cancelWindowText(60)).toBe("1 minute");
    expect(cancelWindowText(600)).toBe("10 minutes");
    expect(cancelWindowMinutesField(20)).toBe("1");
    expect(cancelWindowMinutesField(600)).toBe("10");
  });
});

describe("step 5's message names what was scheduled", () => {
  it("from the result, not a fixed sentence", () => {
    const rosa = { vendorName: "Rosa Villanueva", amountMinor: 19_000, currency: "USD" };
    const maria = { vendorName: "Maria Santos", amountMinor: 18_000, currency: "USD" };
    expect(autopilotMessage([rosa], "1 minute")).toMatch(/Rosa Villanueva USD 190\.00 is scheduled/);
    expect(autopilotMessage([rosa, maria], "1 minute")).toMatch(/Rosa Villanueva USD 190\.00 and Maria Santos USD 180\.00 are scheduled/);
    expect(autopilotMessage([], "1 minute")).toMatch(/Nothing new was ready/);
  });
});

describe("step 5 when step 4 was skipped", () => {
  let db: Db;
  beforeAll(async () => {
    db = openTestDb();
    state.db = db;
    await seedDemo(db, { history: true });
    state.headers = new Headers({ [ACTOR_HEADER]: "daniel", [ROLE_HEADER]: "admin" });
  }, 60_000);

  it("never pays or schedules step 4's request: it asks for step 4 first and changes nothing", async () => {
    const step4 = () => db.select().from(obligations).where(eq(obligations.sourceRef, "JOB-HG4D-0921")).get()!;
    expect(step4().state).toBe("approved");
    const before = db.select().from(obligations).all().length;
    const r = await tourAutopilotAction();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^Do step 4 first\. Maria Santos USD 180\.00/);
    expect(step4().state).toBe("approved");
    expect(step4().releaseAt).toBeNull();
    expect(db.select().from(obligations).all().length).toBe(before); // Rosa not brought in either
    expect(db.select().from(obligations).all().some((o) => o.releaseAt)).toBe(false);
  }, 60_000);

  it("after step 4, schedules Rosa and names her", async () => {
    db.update(obligations).set({ state: "cancelled" }).where(eq(obligations.sourceRef, "JOB-HG4D-0921")).run(); // a person decided
    const r = await tourAutopilotAction();
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/Rosa Villanueva USD 190\.00 is scheduled/);
    const scheduled = db.select().from(obligations).all().filter((o) => o.releaseAt && o.state === "approved");
    expect(scheduled.map((o) => o.sourceRef)).toEqual(["JOB-CEB2D-1024"]);
  }, 60_000);
});
