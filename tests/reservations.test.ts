import { describe, expect, it } from "vitest";
import { ReservationCancelledError, ReservationManager, ReservationRejectedError } from "../src/reservations";
import { createTestReservationContext } from "./test-reservation-context";

describe("reservation primitive", () => {
	it("serializes concurrent pull and push on the same database id", async () => {
		const manager = new ReservationManager();
		const push = await manager.acquire(input({ entryId: "push", type: "push", policy: "manual" }));

		await expect(manager.acquire(input({ entryId: "pull", type: "pull", policy: "manual" })))
			.rejects.toBeInstanceOf(ReservationRejectedError);

		push.release();
	});

	it("serializes overlapping vault folders across different databases", async () => {
		const manager = new ReservationManager();
		const broad = await manager.acquire(input({ entryId: "a", databaseId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", vaultFolder: "_relay", type: "pull", policy: "manual" }));

		await expect(manager.acquire(input({ entryId: "b", databaseId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", vaultFolder: "_relay/B", type: "pull", policy: "manual" })))
			.rejects.toThrow("Folder _relay/B is busy");

		broad.release();
	});

	it("queues batch operations and starts them after the conflicting manual reservation releases", async () => {
		const manager = new ReservationManager();
		const manual = await manager.acquire(input({ entryId: "manual", policy: "manual" }));
		const queued = manager.acquire(input({ entryId: "batch", policy: "batch" }));

		expect(manager.snapshots()).toHaveLength(1);
		manual.release();
		const batch = await queued;
		expect(batch.entryId).toBe("batch");
		expect(manager.snapshots()).toHaveLength(1);
		batch.release();
	});

	it("cancels queued batch entries without cancelling unrelated active entries", async () => {
		const manager = new ReservationManager();
		const active = await manager.acquire(input({ entryId: "active", policy: "manual" }));
		const queued = manager.acquire(input({ entryId: "queued", policy: "batch" }));

		expect(manager.cancel("queued")).toBe(true);
		await expect(queued).rejects.toBeInstanceOf(ReservationCancelledError);
		expect(active.signal.aborted).toBe(false);
		active.release();
	});

	it("exposes active-operation snapshots with start time, type, and entry id", async () => {
		const manager = new ReservationManager();
		const active = await manager.acquire(input({ entryId: "db-1", type: "push", policy: "manual" }));
		expect(manager.snapshots()[0]).toMatchObject({
			entryId: "db-1",
			type: "push",
		});
		expect(manager.snapshots()[0].startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		active.release();
	});

	it("returns an active opaque context and invalidates it on release", async () => {
		const manager = new ReservationManager();
		const active = await manager.acquire(input({ entryId: "db-1", type: "push", policy: "manual" }));

		expect(active.context.id).toBe(active.id);
		expect(manager.hasReservationContext(active.context)).toBe(true);
		active.release();
		expect(manager.hasReservationContext(active.context)).toBe(false);
	});

	it("keeps synthetic contexts isolated to tests", () => {
		const context = createTestReservationContext("test-context");

		expect(context.id).toBe("test-context");
		expect(new ReservationManager().hasReservationContext(context)).toBe(false);
	});
});

function input(overrides: Partial<Parameters<ReservationManager["acquire"]>[0]> = {}): Parameters<ReservationManager["acquire"]>[0] {
	return {
		entryId: overrides.entryId ?? "db",
		entryName: overrides.entryName ?? "Bugs DB",
		databaseId: overrides.databaseId ?? "0123456789abcdef0123456789abcdef",
		vaultFolder: overrides.vaultFolder ?? "_relay/Bugs DB",
		type: overrides.type ?? "pull",
		policy: overrides.policy ?? "manual",
		maxQueueDepth: overrides.maxQueueDepth,
	};
}
