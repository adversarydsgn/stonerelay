import { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints";

type SchemaProperty = {
	type?: string;
	select?: { options?: Array<{ name: string }> };
	status?: { options?: Array<{ name: string }> };
};

export type NotionDbSchema =
	{ properties?: Record<string, SchemaProperty> };

export type PulledRow =
	| PageObjectResponse
	| { properties?: Record<string, unknown>; frontmatter?: Record<string, unknown>; [key: string]: unknown };

export interface InferredViews {
	dateProperty: string | null;
	statusProperty: {
		name: string;
		type: "select" | "status" | "boolean";
		openValue: string | boolean;
	} | null;
	categoryProperty: string | null;
}

export interface BaseConfig {
	folderPath: string;
	notionId: string;
	order: string[];
}

const datePattern = /date|time|added|decided|locked|created|modified|updated|last edited/i;
const statusPattern = /status|resolved|closed|done|complete/i;
const categoryPattern = /severity|priority|category|type|tier|bucket|kind/i;
const openValues = ["open", "active", "in progress", "pending", "todo", "new"];
const categoryPriority = ["severity", "priority", "tier", "category", "type", "kind", "bucket"];

export function inferDefaultViews(
	rows: PulledRow[],
	schema: NotionDbSchema
): InferredViews {
	const properties = getSchemaProperties(schema);
	const sampleRows = rows.slice(0, 10);

	return {
		dateProperty: inferDateProperty(sampleRows, properties),
		statusProperty: inferStatusProperty(sampleRows, properties),
		categoryProperty: inferCategoryProperty(properties),
	};
}

export function buildBaseFile(
	inferred: InferredViews,
	baseConfig: BaseConfig
): string {
	const yamlLines = buildBaseHeader(baseConfig.folderPath, baseConfig.notionId);
	const views = buildViews(inferred, baseConfig.order);

	yamlLines.push("views:");
	for (const view of views) {
		yamlLines.push("  - type: table");
		yamlLines.push(`    name: ${view.name}`);
		if (view.filter) {
			yamlLines.push("    filters:");
			yamlLines.push("      and:");
			yamlLines.push(`        - ${view.filter}`);
		}
		if (view.sort) {
			yamlLines.push("    sort:");
			yamlLines.push(`      - property: ${quoteYamlString(view.sort.property)}`);
			yamlLines.push(`        direction: ${view.sort.direction}`);
		}
		if (view.groupBy) {
			yamlLines.push(`    group_by: ${quoteYamlString(view.groupBy)}`);
		}
		if (view.order.length > 0) {
			yamlLines.push("    order:");
			for (const prop of view.order) {
				yamlLines.push(`      - ${quoteYamlString(prop)}`);
			}
		}
		yamlLines.push("");
	}

	return yamlLines.join("\n");
}

function inferDateProperty(
	rows: PulledRow[],
	properties: Record<string, SchemaProperty>
): string | null {
	const candidates = Object.keys(properties).filter((name) => {
		if (!datePattern.test(name)) return false;
		const type = properties[name]?.type;
		return isDateType(type) || rows.some((row) => isIsoDateLike(getRowValue(row, name)));
	});

	if (candidates.length === 0) return null;

	for (const preferred of ["Date Decided", "Date Added", "Date", "Date Locked"]) {
		const match = candidates.find((name) => name.toLowerCase() === preferred.toLowerCase());
		if (match) return match;
	}

	return (
		candidates.find((name) => /created/i.test(name)) ??
		candidates.find((name) => /modified|updated|last edited/i.test(name)) ??
		candidates.find((name) => isDateType(properties[name]?.type)) ??
		candidates[0]
	);
}

function inferStatusProperty(
	rows: PulledRow[],
	properties: Record<string, SchemaProperty>
): InferredViews["statusProperty"] {
	for (const [name, config] of Object.entries(properties)) {
		if (!statusPattern.test(name)) continue;

		if (config.type === "select" || config.type === "status") {
			const value = findOpenStringValue(name, config, rows);
			if (value) {
				return { name, type: config.type, openValue: value };
			}
		}

		if (config.type === "checkbox" || config.type === "boolean") {
			return { name, type: "boolean", openValue: false };
		}
	}

	return null;
}

function inferCategoryProperty(
	properties: Record<string, SchemaProperty>
): string | null {
	const candidates = Object.keys(properties).filter((name) => {
		const type = properties[name]?.type;
		return (type === "select" || type === "multi_select") && categoryPattern.test(name);
	});

	if (candidates.length === 0) return null;

	for (const priority of categoryPriority) {
		const match = candidates.find((name) => name.toLowerCase().includes(priority));
		if (match) return match;
	}

	return candidates[0];
}

function buildBaseHeader(folderPath: string, notionId: string): string[] {
	return [
		"filters:",
		"  and:",
		`    - file.inFolder("${folderPath}")`,
		`    - 'note["notion-database-id"] == "${notionId}"'`,
		"",
	];
}

interface BaseView {
	name: string;
	order: string[];
	filter?: string;
	sort?: { property: string; direction: "DESC" };
	groupBy?: string;
}

function buildViews(inferred: InferredViews, order: string[]): BaseView[] {
	const views: BaseView[] = [];

	if (inferred.dateProperty) {
		views.push({
			name: "Recent",
			order: compactOrder(order, inferred.dateProperty, 6),
			sort: { property: inferred.dateProperty, direction: "DESC" },
		});
	}

	if (inferred.statusProperty) {
		views.push({
			name: statusViewName(inferred.statusProperty.name),
			order,
			filter: buildStatusFilter(inferred.statusProperty),
			sort: inferred.dateProperty
				? { property: inferred.dateProperty, direction: "DESC" }
				: undefined,
		});
	}

	if (inferred.categoryProperty) {
		views.push({
			name: `By ${inferred.categoryProperty}`,
			order: order.filter((prop) => prop !== inferred.categoryProperty),
			groupBy: inferred.categoryProperty,
			sort: inferred.dateProperty
				? { property: inferred.dateProperty, direction: "DESC" }
				: undefined,
		});
	}

	views.push({
		name: "All entries",
		order,
	});

	return views;
}

function statusViewName(name: string): string {
	if (/status/i.test(name)) return "Open";
	if (/resolved/i.test(name)) return "Unresolved";
	return "Active";
}

function buildStatusFilter(statusProperty: NonNullable<InferredViews["statusProperty"]>): string {
	const key = expressionKey(statusProperty.name);
	if (typeof statusProperty.openValue === "boolean") {
		return `'note[${key}] == ${statusProperty.openValue}'`;
	}
	return `'note[${key}] == ${quoteExpressionString(statusProperty.openValue)}'`;
}

function compactOrder(order: string[], dateProperty: string, maxColumns: number): string[] {
	const compact = [...order];
	const idIndex = compact.findIndex((prop) => prop.toLowerCase() === "id");
	const id = idIndex === -1 ? null : compact.splice(idIndex, 1)[0];
	const withoutDate = compact.filter((prop) => prop !== dateProperty);
	const result = id ? [id, dateProperty, ...withoutDate] : [dateProperty, ...withoutDate];
	return result.slice(0, maxColumns);
}

function findOpenStringValue(
	name: string,
	config: SchemaProperty,
	rows: PulledRow[]
): string | null {
	const rowValues = rows
		.map((row) => getRowValue(row, name))
		.filter((value): value is string => typeof value === "string");
	const optionValues = config.type === "status"
		? config.status?.options?.map((option) => option.name) ?? []
		: config.select?.options?.map((option) => option.name) ?? [];

	for (const candidate of [...rowValues, ...optionValues]) {
		if (openValues.includes(candidate.toLowerCase())) return candidate;
	}

	return null;
}

function getSchemaProperties(schema: NotionDbSchema): Record<string, SchemaProperty> {
	return schema.properties ?? {};
}

function getRowValue(row: PulledRow, name: string): unknown {
	if ("frontmatter" in row && row.frontmatter) {
		return row.frontmatter[name];
	}

	const properties = "properties" in row ? row.properties : undefined;
	if (properties && name in properties) {
		return simplifyPropertyValue(properties[name]);
	}

	return (row as Record<string, unknown>)[name];
}

function simplifyPropertyValue(value: unknown): unknown {
	if (!value || typeof value !== "object" || !("type" in value)) return value;
	const typed = value as Record<string, any>;

	switch (typed.type) {
		case "date":
			return typed.date?.start ?? null;
		case "created_time":
			return typed.created_time ?? null;
		case "last_edited_time":
			return typed.last_edited_time ?? null;
		case "select":
			return typed.select?.name ?? null;
		case "status":
			return typed.status?.name ?? null;
		case "checkbox":
			return typed.checkbox;
		default:
			return typed[typed.type] ?? null;
	}
}

function isDateType(type: string | undefined): boolean {
	return type === "date" || type === "created_time" || type === "last_edited_time";
}

function isIsoDateLike(value: unknown): boolean {
	if (typeof value !== "string") return false;
	const startsWithIsoDate = /^\d{4}-\d{2}-\d{2}(?:$|[T\s])/.test(value);
	return startsWithIsoDate && !Number.isNaN(Date.parse(value));
}

function quoteYamlString(value: string): string {
	return `"${escapeDoubleQuoted(value)}"`;
}

function quoteExpressionString(value: string): string {
	return `"${escapeDoubleQuoted(value)}"`;
}

function expressionKey(value: string): string {
	return quoteExpressionString(value);
}

function escapeDoubleQuoted(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
