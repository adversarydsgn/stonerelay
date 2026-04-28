import type { ReservationContext } from "../src/reservations";

export function createTestReservationContext(id: string): ReservationContext {
	return Object.freeze({ id }) as ReservationContext;
}
