import type { FrontmatterParseError } from "./push";

type PropertySchema = Record<string, { type: string }>;

const INTERNAL_KEYS = new Set([
	"notion-id",
	"notion-url",
	"notion-frozen-at",
	"notion-last-edited",
	"notion-last-edited-time",
	"notion-database-id",
	"notion-deleted",
]);

const PUSHABLE_TYPES = new Set([
	"title",
	"rich_text",
	"number",
	"select",
	"multi_select",
	"status",
	"date",
	"checkbox",
	"url",
	"email",
	"phone_number",
	"relation",
]);

export type ValidationSeverity = "error" | "warning";

export type ValidationCode =
	| "yaml_syntax"
	| "non_object_root"
	| "unknown_property"
	| "required_missing"
	| "invalid_value"
	| "unsupported_type";

export interface ValidationIssue {
	filePath: string;
	property: string | null;
	severity: ValidationSeverity;
	reason: string;
	code: ValidationCode;
}

interface MarkdownDocumentForValidation {
	file: { path: string };
	props: Record<string, unknown>;
	title: string;
	parseError?: FrontmatterParseError;
}

export interface ValidatedDocument {
	doc: MarkdownDocumentForValidation;
	issues: ValidationIssue[];
	pushable: boolean;
}

export function validateFrontmatter(
	doc: MarkdownDocumentForValidation,
	schema: PropertySchema,
	options: { strict: boolean; titleProp: string }
): ValidatedDocument {
	const issues: ValidationIssue[] = [];
	const filePath = doc.file.path;

	if (doc.parseError) {
		issues.push({
			filePath,
			property: null,
			severity: "error",
			reason: doc.parseError.message,
			code: doc.parseError.kind,
		});
		return { doc, issues, pushable: false };
	}

	if (!doc.title || doc.title.trim() === "") {
		issues.push({
			filePath,
			property: options.titleProp,
			severity: "error",
			reason: "Title is empty. Notion requires a non-empty title to create or update a row.",
			code: "required_missing",
		});
	}

	for (const [key, value] of Object.entries(doc.props)) {
		if (INTERNAL_KEYS.has(key) || key === options.titleProp) continue;

		const schemaProp = schema[key];
		if (!schemaProp) {
			issues.push({
				filePath,
				property: key,
				severity: options.strict ? "error" : "warning",
				reason: `Property "${key}" is not in the Notion database schema and will be dropped.`,
				code: "unknown_property",
			});
			continue;
		}

		if (!PUSHABLE_TYPES.has(schemaProp.type)) {
			issues.push({
				filePath,
				property: key,
				severity: "warning",
				reason: `Property type "${schemaProp.type}" is read-only in Notion and cannot be pushed.`,
				code: "unsupported_type",
			});
			continue;
		}

		const invalid = detectInvalidValue(key, value, schemaProp.type);
		if (invalid) {
			issues.push({
				filePath,
				property: key,
				severity: options.strict ? "error" : "warning",
				reason: invalid,
				code: "invalid_value",
			});
		}
	}

	const hasError = issues.some((issue) => issue.severity === "error");
	return { doc, issues, pushable: !hasError };
}

function detectInvalidValue(key: string, value: unknown, type: string): string | null {
	if (value === null || value === undefined || value === "") return null;

	switch (type) {
		case "number":
			if (typeof value !== "number" && (typeof value !== "string" || !/^-?\d+(\.\d+)?$/.test(value.trim()))) {
				return `Expected a number for "${key}", got ${JSON.stringify(value)}.`;
			}
			break;
		case "checkbox":
			if (typeof value !== "boolean" && !/^(true|false|yes|no|1|0)$/i.test(String(value).trim())) {
				return `Expected true/false for "${key}", got ${JSON.stringify(value)}.`;
			}
			break;
		case "select":
		case "status":
			if (typeof value !== "string") {
				return `Expected a string for "${key}" (${type}), got ${JSON.stringify(value)}.`;
			}
			break;
		case "multi_select":
		case "relation":
			if (!Array.isArray(value) && typeof value !== "string") {
				return `Expected an array or comma-separated string for "${key}" (${type}), got ${JSON.stringify(value)}.`;
			}
			break;
	}
	return null;
}
