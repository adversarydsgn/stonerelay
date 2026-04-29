import { Conflict, SourceOfTruth } from "./types";

export type ChangeState = "skip" | "pull" | "push" | "conflict";
export type ConflictChoice = "keep_notion" | "keep_vault" | "skip";

export interface ConflictDecision {
	action: ChangeState;
	conflict?: Conflict;
	warning?: string;
}

export interface ConflictInput {
	rowId: string;
	notionChanged: boolean;
	vaultChanged: boolean;
	sourceOfTruth: SourceOfTruth | null;
	templaterManaged?: boolean;
	notionEditedAt: string;
	vaultEditedAt: string;
	notionSnapshot: Record<string, unknown>;
	vaultSnapshot: Record<string, unknown>;
	detectedAt: string;
}

export interface ConflictResolutionResult {
	conflicts: Conflict[];
	action: "pull" | "push" | "skip";
}

export function decideBidirectionalAction(input: ConflictInput): ConflictDecision {
	if (!input.notionChanged && !input.vaultChanged) return { action: "skip" };
	if (input.notionChanged && !input.vaultChanged) return { action: "pull" };
	if (!input.notionChanged && input.vaultChanged) return { action: "push" };

	if (input.templaterManaged || input.sourceOfTruth === "manual_merge") {
		return {
			action: "conflict",
			conflict: buildConflictSnapshot(input),
		};
	}
	if (input.sourceOfTruth === "obsidian") {
		return {
			action: "push",
			warning: `Both sides changed for ${input.rowId}; vault wins by source_of_truth.`,
		};
	}
	return {
		action: "pull",
		warning: `Both sides changed for ${input.rowId}; Notion wins by source_of_truth.`,
	};
}

function buildConflictSnapshot(input: ConflictInput): Conflict {
	return {
		rowId: input.rowId,
		notionEditedAt: input.notionEditedAt,
		vaultEditedAt: input.vaultEditedAt,
		notionSnapshot: { ...input.notionSnapshot },
		vaultSnapshot: { ...input.vaultSnapshot },
		detectedAt: input.detectedAt,
	};
}

export function resolveManualMergeConflict(
	conflicts: Conflict[],
	rowId: string,
	choice: ConflictChoice
): ConflictResolutionResult {
	if (choice === "skip") {
		return { conflicts, action: "skip" };
	}
	return {
		conflicts: conflicts.filter((conflict) => conflict.rowId !== rowId),
		action: choice === "keep_notion" ? "pull" : "push",
	};
}

export function conflictCountForRows(conflicts: Conflict[], rowIds: Set<string>): number {
	return conflicts.filter((conflict) => rowIds.has(conflict.rowId)).length;
}
