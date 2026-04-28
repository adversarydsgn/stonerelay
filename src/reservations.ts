import { normalizeNotionId } from "./notion-client";

export type ReservationPolicy = "manual" | "batch" | "auto";
export type ReservationOperationType = "pull" | "push" | "page" | "conflict" | "startup" | "atomic-write";
export const RESERVATION_MANAGER_LOCK_KIND = "reservation-manager";
export const RESERVATION_PATH_LOCK_KIND = "reservation-path-lock";

declare const ReservationContextBrand: unique symbol;

export type ReservationContext = {
	readonly id: string;
	readonly [ReservationContextBrand]: true;
};

export interface ReservationAcquireInput {
	entryId: string;
	entryName: string;
	databaseId: string;
	vaultFolder: string;
	type: ReservationOperationType;
	policy: ReservationPolicy;
	maxQueueDepth?: number;
	externalSignal?: AbortSignal;
}

export interface ActiveReservationSnapshot {
	id: string;
	entryId: string;
	entryName: string;
	databaseId: string;
	vaultFolder: string;
	type: ReservationOperationType;
	startedAt: string;
}

export interface ReservationHandle extends ActiveReservationSnapshot {
	lockKind: typeof RESERVATION_MANAGER_LOCK_KIND;
	context: ReservationContext;
	controller: AbortController;
	signal: AbortSignal;
	release: () => void;
}

interface QueuedReservation {
	input: ReservationAcquireInput;
	resolve: (handle: ReservationHandle) => void;
	reject: (error: Error) => void;
	cancelled: boolean;
}

interface ReservationRecord extends ActiveReservationSnapshot {
	context: ReservationContext;
	controller: AbortController;
	release: () => void;
}

export class ReservationRejectedError extends Error {
	constructor(message: string, readonly conflictingReservation: ActiveReservationSnapshot) {
		super(message);
		this.name = "ReservationRejectedError";
	}
}

export class ReservationQueueFullError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ReservationQueueFullError";
	}
}

export class ReservationCancelledError extends Error {
	constructor(message = "Reservation cancelled before it started.") {
		super(message);
		this.name = "ReservationCancelledError";
	}
}

export class ReservationPathLock {
	readonly kind = RESERVATION_PATH_LOCK_KIND;

	constructor(readonly path: string) {}
}

export class ReservationManager {
	private active = new Map<string, ReservationRecord>();
	private queued: QueuedReservation[] = [];
	private issuedContexts = new WeakSet<ReservationContext>();

	async acquire(input: ReservationAcquireInput): Promise<ReservationHandle> {
		const conflict = this.findConflict(input);
		if (!conflict) return this.activate(input);

		if (input.policy === "manual") {
			throw new ReservationRejectedError(busyMessage(input, conflict), conflict);
		}

		const maxQueueDepth = input.maxQueueDepth ?? (input.policy === "auto" ? 1 : 3);
		const queueDepth = this.queued.filter((queued) => !queued.cancelled && this.conflicts(queued.input, input)).length;
		if (queueDepth >= maxQueueDepth) {
			throw new ReservationQueueFullError(`Reservation queue full for ${input.entryName}. ${busyMessage(input, conflict)}`);
		}

		return new Promise((resolve, reject) => {
			const queued: QueuedReservation = { input, resolve, reject, cancelled: false };
			if (input.externalSignal) {
				if (input.externalSignal.aborted) {
					reject(new ReservationCancelledError());
					return;
				}
				input.externalSignal.addEventListener("abort", () => {
					queued.cancelled = true;
					reject(new ReservationCancelledError());
				}, { once: true });
			}
			this.queued.push(queued);
		});
	}

	cancel(idOrEntryId: string): boolean {
		const active = this.active.get(idOrEntryId) ?? [...this.active.values()].find((record) => record.entryId === idOrEntryId);
		if (active) {
			active.controller.abort();
			return true;
		}
		const queued = this.queued.find((record) =>
			!record.cancelled && (record.input.entryId === idOrEntryId)
		);
		if (queued) {
			queued.cancelled = true;
			queued.reject(new ReservationCancelledError());
			return true;
		}
		return false;
	}

	cancelAll(): void {
		for (const active of this.active.values()) {
			active.controller.abort();
		}
		for (const queued of this.queued) {
			if (!queued.cancelled) {
				queued.cancelled = true;
				queued.reject(new ReservationCancelledError());
			}
		}
	}

	hasEntry(entryId: string): boolean {
		return [...this.active.values()].some((record) => record.entryId === entryId);
	}

	hasReservation(reservationId: string): boolean {
		return this.active.has(reservationId);
	}

	hasReservationContext(context: ReservationContext | undefined): boolean {
		return Boolean(context && this.issuedContexts.has(context) && this.active.has(context.id));
	}

	size(): number {
		return this.active.size;
	}

	snapshots(): ActiveReservationSnapshot[] {
		return [...this.active.values()].map(({ controller: _controller, release: _release, ...snapshot }) => snapshot);
	}

	private activate(input: ReservationAcquireInput): ReservationHandle {
		const controller = new AbortController();
		if (input.externalSignal) {
			if (input.externalSignal.aborted) controller.abort();
			else input.externalSignal.addEventListener("abort", () => controller.abort(), { once: true });
		}
		const id = crypto.randomUUID();
		const snapshot: ActiveReservationSnapshot = {
			id,
			entryId: input.entryId,
			entryName: input.entryName,
			databaseId: normalizeReservationDatabaseId(input.databaseId),
			vaultFolder: normalizeReservationFolder(input.vaultFolder),
			type: input.type,
			startedAt: new Date().toISOString(),
		};
		const release = () => {
			if (!this.active.delete(id)) return;
			this.drainQueue();
		};
		const context = createReservationContext(id);
		this.issuedContexts.add(context);
		const record: ReservationRecord = { ...snapshot, context, controller, release };
		this.active.set(id, record);
		return {
			...snapshot,
			lockKind: RESERVATION_MANAGER_LOCK_KIND,
			context,
			controller,
			signal: controller.signal,
			release,
		};
	}

	private drainQueue(): void {
		for (const queued of [...this.queued]) {
			if (queued.cancelled) {
				this.queued = this.queued.filter((item) => item !== queued);
				continue;
			}
			if (this.findConflict(queued.input)) continue;
			this.queued = this.queued.filter((item) => item !== queued);
			queued.resolve(this.activate(queued.input));
		}
	}

	private findConflict(input: ReservationAcquireInput): ActiveReservationSnapshot | null {
		return this.snapshots().find((active) => this.conflicts(active, input)) ?? null;
	}

	private conflicts(
		left: Pick<ReservationAcquireInput | ActiveReservationSnapshot, "databaseId" | "vaultFolder">,
		right: Pick<ReservationAcquireInput | ActiveReservationSnapshot, "databaseId" | "vaultFolder">
	): boolean {
		const leftDb = normalizeReservationDatabaseId(left.databaseId);
		const rightDb = normalizeReservationDatabaseId(right.databaseId);
		if (leftDb && rightDb && leftDb === rightDb) return true;
		return foldersOverlap(left.vaultFolder, right.vaultFolder);
	}
}

function createReservationContext(id: string): ReservationContext {
	return Object.freeze({ id }) as ReservationContext;
}

const fileLocks = new Map<string, Promise<void>>();
const activeFileLocks = new Map<string, ReservationPathLock>();

export function getActiveReservationPathLocks(): ReservationPathLock[] {
	return [...activeFileLocks.values()];
}

export async function withReservationPathLock<T>(path: string, task: () => Promise<T>): Promise<T> {
	const key = normalizeReservationFolder(path);
	const previous = fileLocks.get(key) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tail = previous.then(() => current, () => current);
	fileLocks.set(key, tail);
	await previous.catch(() => undefined);
	const activeLock = new ReservationPathLock(key);
	activeFileLocks.set(key, activeLock);
	try {
		return await task();
	} finally {
		activeFileLocks.delete(key);
		release();
		if (fileLocks.get(key) === tail) fileLocks.delete(key);
	}
}

export function foldersOverlap(left: string, right: string): boolean {
	const a = normalizeReservationFolder(left);
	const b = normalizeReservationFolder(right);
	if (!a || !b) return false;
	return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function normalizeReservationDatabaseId(value: string): string {
	try {
		return normalizeNotionId(value);
	} catch {
		return String(value ?? "").replace(/-/g, "").trim().toLowerCase();
	}
}

function normalizeReservationFolder(value: string): string {
	return String(value ?? "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "").toLowerCase();
}

function busyMessage(input: ReservationAcquireInput, conflict: ActiveReservationSnapshot): string {
	const started = new Date(conflict.startedAt);
	const startedAt = Number.isNaN(started.getTime())
		? conflict.startedAt
		: started.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	const sameDb = normalizeReservationDatabaseId(input.databaseId) === normalizeReservationDatabaseId(conflict.databaseId);
	const surface = sameDb ? `DB ${input.entryName}` : `Folder ${input.vaultFolder}`;
	return `${surface} is busy with ${conflict.type} operation ${conflict.entryName} (started ${startedAt}).`;
}
