import { App, ButtonComponent, Modal, Notice, PluginSettingTab, Setting, TFile, TFolder, normalizePath } from "obsidian";
import NotionFreezePlugin from "./main";
import { Conflict, SyncDirection, SyncedDatabase } from "./types";
import { createNotionClient } from "./notion-client";
import {
	addDatabase,
	createDatabaseEntry,
	removeDatabase,
	updateDatabase,
} from "./settings-data";
import {
	DatabaseMetadata,
	DIRECTION_HELPER,
	DIRECTION_LABELS,
	DIRECTION_OPTION_ORDER,
	DIRECTION_SECTION_HELPER,
	PREVIEW_PLACEHOLDER,
	VaultFolderStats,
	autoSyncReadiness,
	buildConnectionPreviewRows,
	directionChangeWarning,
	fetchDatabaseMetadata,
	formWarnings,
	lastEditSideIndicator,
	parseNotionDbId,
	pendingConflictCount,
	shouldAutoFillDatabaseName,
	shouldConfirmDirectionChange,
	syncHistoryTitle,
	syncedDatabasesHeader,
	slugify,
	trimApiKey,
	vaultFolderHelper,
} from "./settings-ux";
import { resolveManualMergeConflict } from "./conflict-resolution";

interface EditState {
	input: string;
	fetchedTitle: string | null;
	status: "idle" | "fetching" | "success" | "error" | "notice";
	message: string;
	metadata?: DatabaseMetadata;
	validationError?: string;
	nameTouched: boolean;
	outputTouched: boolean;
	requestId: number;
}

export class NotionFreezeSettingTab extends PluginSettingTab {
	plugin: NotionFreezePlugin;
	private editingId: string | null = null;
	private draft: SyncedDatabase | null = null;
	private editState: EditState | null = null;
	private registeredRefresh = false;
	private expandedErrorIds = new Set<string>();
	private syncingIds = new Set<string>();

	constructor(app: App, plugin: NotionFreezePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		if (!this.registeredRefresh) {
			this.plugin.registerEvent(
				(this.app.workspace as any).on("stonerelay:settings-updated", () => this.display())
			);
			this.registeredRefresh = true;
		}

		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Notion API key")
			.setDesc(
				"Create an integration at notion.so/profile/integrations and paste the key here."
			)
			.addText((text) =>
				text
					.setPlaceholder("Paste your integration token")
					.setValue(this.plugin.settings.apiKey)
					.then((t) => {
						t.inputEl.type = "password";
						t.inputEl.addClass("notion-sync-input-wide");
						t.inputEl.addEventListener("paste", () => {
							setTimeout(() => {
								const trimmed = trimApiKey(t.inputEl.value);
								t.setValue(trimmed);
								void this.saveApiKey(trimmed);
							});
						});
						t.inputEl.addEventListener("blur", () => {
							const trimmed = trimApiKey(t.inputEl.value);
							t.setValue(trimmed);
							void this.saveApiKey(trimmed);
						});
					})
					.onChange((value) => {
						this.plugin.settings.apiKey = trimApiKey(value);
						void this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Default output folder")
			.setDesc("Where synced Notion content will be saved by default.")
			.addText((text) =>
				text
					.setPlaceholder("Notion")
					.setValue(this.plugin.settings.defaultOutputFolder)
					.onChange(async (value) => {
						this.plugin.settings.defaultOutputFolder = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Default error log folder")
			.setDesc("Optional vault folder for sync error logs. Per-database overrides take precedence.")
			.addText((text) =>
				text
					.setPlaceholder("_relay/errors")
					.setValue(this.plugin.settings.defaultErrorLogFolder)
					.onChange(async (value) => {
						this.plugin.settings.defaultErrorLogFolder = value.trim();
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h3", { text: syncedDatabasesHeader(this.plugin.settings.databases) });
		if (!this.plugin.settings.apiKey) {
			containerEl.createEl("div", {
				cls: "stonerelay-api-key-notice",
				text: "⚠ Set your Notion API key above before adding databases.",
			});
		}
		containerEl.createEl("p", {
			cls: "setting-item-description stonerelay-section-desc",
			text: "Notion databases that get synced when you run pull or push commands. v0.6 pushes frontmatter properties only; page body sync is planned for v0.7.",
		});

		if (this.plugin.settings.databases.length === 0 && !this.draft) {
			containerEl.createEl("p", {
				cls: "setting-item-description",
				text: "No databases configured yet. Click \"Add database\" below to start, or paste a Notion link from any database you want to mirror locally.",
			});
		}

		for (const entry of this.plugin.settings.databases) {
			if (this.editingId === entry.id && this.draft) {
				this.renderEditRow(containerEl, this.draft);
			} else {
				this.renderDatabaseRow(containerEl, entry);
			}
		}

		if (this.editingId === "__new__" && this.draft) {
			this.renderEditRow(containerEl, this.draft);
		}

		if (this.draft) {
			containerEl.createEl("hr", { cls: "stonerelay-edit-divider" });
		}

		new Setting(containerEl)
			.addButton((btn) =>
				btn
					.setButtonText("Add database")
					.onClick(() => {
						this.editingId = "__new__";
						this.draft = createDatabaseEntry({
							id: crypto.randomUUID(),
							name: "",
							databaseId: "",
							outputFolder: "",
							direction: "pull",
							enabled: true,
							current_phase: "phase_1",
							initial_seed_direction: "pull",
							source_of_truth: null,
						});
						this.editState = this.createEditState("");
						this.display();
					})
			)
			.addButton((btn) => {
				btn
					.setButtonText("Sync all enabled")
					.setCta()
					.onClick(() => {
						void this.plugin.syncAllEnabledDatabases();
					});
				btn.setDisabled(this.plugin.isCancellingAll() || this.plugin.hasActiveSyncs());
				if (!this.plugin.settings.databases.some((entry) => entry.enabled)) {
					btn.buttonEl.hide();
				}
			})
			.addButton((btn) => {
				btn
					.setButtonText("Push all enabled")
					.onClick(() => {
						void this.plugin.pushAllEnabledDatabases();
					});
				if (!this.plugin.settings.databases.some((entry) => entry.enabled && canPush(entry))) {
					btn.buttonEl.hide();
				}
			})
			.addButton((btn) => {
				btn
					.setButtonText("Cancel all")
					.onClick(() => this.plugin.cancelAllSyncs());
				btn.setDisabled(this.plugin.isCancellingAll() || !this.plugin.hasActiveSyncs());
				if (!this.plugin.settings.databases.some((entry) => this.plugin.isSyncActive(entry.id))) {
					btn.buttonEl.hide();
				}
			});
	}

	private async saveApiKey(value: string): Promise<void> {
		if (this.plugin.settings.apiKey === value) return;
		this.plugin.settings.apiKey = value;
		await this.plugin.saveSettings();
	}

	private renderDatabaseRow(containerEl: HTMLElement, entry: SyncedDatabase): void {
		const desc = document.createDocumentFragment();
		const conflictCount = pendingConflictCount(entry, this.plugin.settings.pendingConflicts);
		desc.append(document.createTextNode(`${entry.databaseId}  ·  ${entry.outputFolder || "Default folder"}  ·  ${directionIcon(entry)} ${directionLabelShort(entry)}  ·  ${lastEditSideIndicator(entry, this.plugin.settings.pendingConflicts)}  ·  `));
		desc.appendChild(this.formatLastSync(entry));
		desc.append(document.createTextNode(`  ·  ${autoSyncReadiness(entry, this.plugin.settings.pendingConflicts)}`));
		if (entry.current_phase === "phase_2") {
			desc.append(document.createTextNode("  ·  Phase 2"));
		}
		if (entry.lastSyncStatus === "partial" && entry.lastSyncErrors.length > 0) {
			desc.append(document.createTextNode(`  ·  ${entry.lastSyncErrors.length} failed`));
		}
		if (entry.direction === "bidirectional" && conflictCount > 0) {
			desc.append(document.createTextNode(`  ·  ⚠ ${conflictCount} conflicts`));
		}

		const setting = new Setting(containerEl)
			.setDesc(desc)
			.addToggle((toggle) =>
				toggle
					.setValue(entry.enabled)
					.onChange(async (value) => {
						this.plugin.settings = updateDatabase(this.plugin.settings, {
							...entry,
							enabled: value,
						});
						await this.plugin.saveSettings();
						this.display();
					})
			);
		renderDatabaseName(setting.nameEl, entry);

		if (this.syncingIds.has(entry.id) || this.plugin.isSyncActive(entry.id)) {
			setting.controlEl.createSpan({
				cls: "stonerelay-inline-status stonerelay-fetching",
				text: "Syncing...",
			});
			setting.addButton((btn) =>
				btn
					.setButtonText("Cancel")
					.onClick(() => this.plugin.cancelSync(entry.id))
			);
		} else {
			setting.addButton((btn) =>
				btn
					.setButtonText("Pull")
					.setIcon("arrow-down")
					.onClick(() => {
						void this.syncRow(entry);
					})
			);
			if (canPush(entry)) {
				setting.addButton((btn) =>
					btn
						.setButtonText("Push")
						.setIcon("arrow-up")
						.onClick(() => {
							void this.pushRow(entry);
						})
				);
			}
			if (entry.lastSyncStatus === "partial" && entry.lastSyncErrors.length > 0) {
				setting.addButton((btn) =>
					btn
						.setButtonText("Retry failed rows")
						.onClick(() => {
							void this.retryFailedRows(entry);
						})
				);
			}
			if (conflictCount > 0) {
				setting.addButton((btn) =>
					btn
						.setButtonText("Conflicts")
						.onClick(() => {
							new ConflictResolutionModal(this.app, this.plugin.settings.pendingConflicts, async (next) => {
								this.plugin.settings = {
									...this.plugin.settings,
									pendingConflicts: next,
								};
								await this.plugin.saveSettings();
								this.display();
							}, async (conflict, action) => {
								await this.plugin.applyConflictResolution(conflict, action);
							}).open();
						})
				);
			}
		}

		setting
			.addButton((btn) => {
				btn.setIcon("pencil")
					.onClick(() => {
						this.editingId = entry.id;
						this.draft = { ...entry };
						this.editState = this.createEditState(entry.databaseId, entry.name);
						this.display();
					});
				btn.buttonEl.title = "Edit";
				btn.buttonEl.ariaLabel = "Edit";
			})
			.addButton((btn) => {
				btn.setIcon("trash")
					.onClick(() => {
						new ConfirmRemoveModal(this.app, entry.name, async () => {
							this.plugin.settings = removeDatabase(this.plugin.settings, entry.id);
							await this.plugin.saveSettings();
							this.editingId = null;
							this.draft = null;
							this.editState = null;
							this.display();
						}).open();
					});
				btn.buttonEl.title = "Delete";
				btn.buttonEl.ariaLabel = "Delete";
				btn.buttonEl.addClass("stonerelay-delete-button");
			});

		if (entry.lastSyncStatus === "error" && this.expandedErrorIds.has(entry.id)) {
			containerEl.createEl("pre", {
				cls: "stonerelay-sync-error-detail",
				text: entry.lastSyncError || "Sync failed",
			});
		}
		if (entry.lastSyncStatus === "partial" && this.expandedErrorIds.has(entry.id)) {
			containerEl.createEl("pre", {
				cls: "stonerelay-sync-error-detail",
				text: entry.lastSyncErrors.map((error) => `${error.rowId}: ${error.error}`).join("\n"),
			});
		}
	}

	private renderEditRow(containerEl: HTMLElement, draft: SyncedDatabase): void {
		const state = this.editState ?? this.createEditState(draft.databaseId, draft.name);
		this.editState = state;
		const wrapper = containerEl.createDiv({ cls: "stonerelay-database-edit" });
		let statusEl: HTMLElement;
		let nameInput: { setValue(value: string): unknown } | null = null;
		let outputInput: { setValue(value: string): unknown } | null = null;
		let testButton: ButtonComponent | null = null;
		let outputDescEl: HTMLElement | null = null;
		let previewEl: HTMLElement | null = null;
		let warningsEl: HTMLElement | null = null;
		const originalEntry = this.editingId && this.editingId !== "__new__"
			? this.plugin.settings.databases.find((entry) => entry.id === this.editingId) ?? null
			: null;

		const save = async (directionChangeConfirmed = false) => {
			const databaseId = parseNotionDbId(state.input);
			if (!databaseId) {
				state.validationError = "Invalid Notion database URL or ID. Expected a Notion link or a 32-character hex ID.";
				this.display();
				return;
			}

			const finalName = draft.name.trim() || state.fetchedTitle || "";
			const finalOutput = draft.outputFolder.trim() || "_relay/";
			if (!finalName) {
				state.validationError = "Name is required when DB info has not been fetched from Notion.";
				this.display();
				return;
			}
			if (!isValidRelativePath(finalOutput)) {
				state.validationError = "Output folder must be a relative vault path without ../ traversal.";
				this.display();
				return;
			}
			if (draft.errorLogFolder.trim() && !isValidRelativePath(draft.errorLogFolder.trim())) {
				state.validationError = "Error log folder must be a relative vault path without ../ traversal.";
				this.display();
				return;
			}
			if (this.editingId === "__new__" && draft.direction === "bidirectional") {
				state.validationError = "Bidirectional is only available after first sync completes. Pick Pull or Push to seed the database, then flip to Bidirectional in Edit.";
				this.display();
				return;
			}

			try {
				const entry = createDatabaseEntry({
					...draft,
					name: finalName,
					databaseId,
					outputFolder: finalOutput,
					direction: draft.direction ?? "pull",
					enabled: this.editingId === "__new__" ? true : draft.enabled,
					current_phase: this.editingId === "__new__" ? "phase_1" : draft.current_phase,
					initial_seed_direction: this.editingId === "__new__"
						? (draft.direction === "push" ? "push" : "pull")
						: draft.initial_seed_direction,
					source_of_truth: draft.direction === "bidirectional" ? draft.source_of_truth ?? "notion" : draft.source_of_truth,
					nest_under_db_name: draft.nest_under_db_name,
				});
				if (
					originalEntry &&
					shouldConfirmDirectionChange(originalEntry.direction, entry.direction, originalEntry.lastSyncedAt) &&
					!directionChangeConfirmed
				) {
					new ConfirmDirectionChangeModal(
						this.app,
						originalEntry.direction,
						entry.direction,
						() => {
							void save(true);
						}
					).open();
					return;
				}
				this.plugin.settings = this.editingId === "__new__"
					? addDatabase(this.plugin.settings, entry)
					: updateDatabase(this.plugin.settings, entry);
				await this.plugin.saveSettings();
				this.editingId = null;
				this.draft = null;
				this.editState = null;
				this.display();
			} catch (err) {
				state.validationError = err instanceof Error ? err.message : String(err);
				this.display();
			}
		};
		const cancel = () => {
			this.editingId = null;
			this.draft = null;
			this.editState = null;
			this.display();
		};

		wrapper.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
				event.preventDefault();
				void save();
			}
			if (event.key === "Escape") {
				event.preventDefault();
				cancel();
			}
		});

		new Setting(wrapper)
			.setName(requiredLabel("Notion URL or ID"))
			.setDesc("Paste the Notion database link, or just the 32-character ID. We'll fetch the rest from Notion.")
			.addText((text) =>
				text
					.setPlaceholder("https://www.notion.so/... or 32-character database ID")
					.setValue(state.input)
					.then((t) => {
						t.inputEl.addClass("notion-sync-input-wide");
						t.inputEl.addEventListener("paste", () => {
							setTimeout(() => {
								state.input = t.inputEl.value.trim();
								void runMetadataFetch("auto");
							});
						});
						t.inputEl.addEventListener("blur", () => {
							state.input = t.inputEl.value.trim();
							void runMetadataFetch("auto");
						});
					})
					.onChange((value) => {
						state.input = value.trim();
						draft.databaseId = value.trim();
						state.validationError = undefined;
						updateTestButton();
					})
			);

		statusEl = wrapper.createDiv({ cls: "stonerelay-inline-status" });
		renderStatus();

		new Setting(wrapper)
			.setName("Name")
			.setDesc("A human label for this database. Auto-filled from Notion if blank.")
			.addText((text) =>
				text
					.setPlaceholder("Sessions Mirror")
					.setValue(draft.name)
					.then((t) => {
						nameInput = t;
					})
					.onChange((value) => {
						draft.name = value;
						state.nameTouched = true;
						state.validationError = undefined;
					})
			);

		const outputSetting = new Setting(wrapper)
			.setName("Vault folder")
			.setDesc(vaultFolderHelper(draft.direction ?? "pull"));
		outputDescEl = outputSetting.descEl;
		outputSetting.addText((text) =>
			text
				.setPlaceholder("_relay/")
				.setValue(draft.outputFolder)
				.then((t) => {
					outputInput = t;
				})
				.onChange((value) => {
					draft.outputFolder = value.trim();
					state.outputTouched = true;
					state.validationError = undefined;
					updateFormUx();
				})
		);

		new Setting(wrapper)
			.setName("Error log folder override")
			.setDesc("Optional vault folder for this database's sync error logs. Leave blank to use the global default.")
			.addText((text) =>
				text
					.setPlaceholder(this.plugin.settings.defaultErrorLogFolder || "_relay/errors")
					.setValue(draft.errorLogFolder)
					.onChange((value) => {
						draft.errorLogFolder = value.trim();
						state.validationError = undefined;
					})
			);

		const directionSection = wrapper.createDiv({ cls: "stonerelay-direction-section" });
		directionSection.createEl("div", {
			cls: "stonerelay-section-heading",
			text: "Sync direction",
		});
		directionSection.createEl("div", {
			cls: "setting-item-description stonerelay-direction-section-desc",
			text: draft.current_phase === "phase_1"
				? "Phase 1 - Initial seed. Pick the canonical source. After first successful sync, you can edit this entry to enable Bidirectional partnership."
				: DIRECTION_SECTION_HELPER,
		});
		const group = directionSection.createDiv({ cls: "stonerelay-direction-selector" });
		for (const option of DIRECTION_OPTION_ORDER) {
			const phaseOne = draft.current_phase !== "phase_2";
			const disabled = option === "bidirectional" && phaseOne;
			const button = group.createEl("button", {
				cls: "stonerelay-direction-option",
			});
			button.type = "button";
			button.disabled = disabled;
			button.createSpan({ cls: "stonerelay-direction-radio", text: (draft.direction ?? "pull") === option ? "●" : "○" });
			button.createSpan({ cls: "stonerelay-direction-label", text: directionLabel(option, draft.current_phase === "phase_1") });
			if (disabled) {
				button.addClass("is-disabled");
				button.title = phaseOneBidirectionalHelper();
			}
			if ((draft.direction ?? "pull") === option) {
				button.addClass("is-active");
				button.ariaPressed = "true";
			} else {
				button.ariaPressed = "false";
			}
			button.onClickEvent(() => {
				if (disabled) {
					state.validationError = phaseOneBidirectionalHelper();
					renderStatus();
					return;
				}
				draft.direction = option;
				if (draft.current_phase === "phase_1") {
					draft.initial_seed_direction = option === "push" ? "push" : "pull";
					draft.source_of_truth = null;
				}
				state.validationError = undefined;
				updateFormUx();
				this.display();
			});
		}
		directionSection.createEl("div", {
			cls: "setting-item-description stonerelay-direction-helper",
			text: draft.current_phase === "phase_1" ? phaseOneBidirectionalHelper() : "When both sides change between syncs, source of truth decides which version is kept.",
		});

		if (draft.current_phase === "phase_2" && draft.direction === "bidirectional") {
			new Setting(wrapper)
				.setName("Source of truth")
				.setDesc("When both sides change between syncs, this rule decides which version is kept. Manual merge surfaces conflicts in a sidebar diff view.")
				.addDropdown((dropdown) =>
					dropdown
						.addOption("notion", "Notion (Notion wins on conflict)")
						.addOption("obsidian", "Obsidian (Vault wins on conflict)")
						.addOption("manual_merge", "Manual merge (surface conflicts to user, don't auto-resolve)")
						.setValue(draft.source_of_truth ?? "notion")
						.onChange((value) => {
							draft.source_of_truth = value as SyncedDatabase["source_of_truth"];
						})
				);
		}

		new Setting(wrapper)
			.setName("Nest files under database subfolder")
			.setDesc(resolvedPathPreview(draft))
			.addToggle((toggle) =>
				toggle
					.setValue(draft.nest_under_db_name)
					.onChange((value) => {
						draft.nest_under_db_name = value;
						this.display();
					})
			);

		new Setting(wrapper)
			.addButton((btn) => {
				testButton = btn
					.setButtonText("Test connection")
					.onClick(() => {
						void runMetadataFetch("test");
					});
				updateTestButton();
			});
		previewEl = wrapper.createDiv({ cls: "stonerelay-connection-preview" });

		warningsEl = wrapper.createDiv({ cls: "stonerelay-form-warnings" });

		const footer = wrapper.createDiv({ cls: "stonerelay-edit-footer" });
		new Setting(footer)
			.addButton((btn) =>
				btn
					.setButtonText("Cancel")
					.onClick(cancel)
			)
			.addButton((btn) =>
				btn
					.setButtonText("Save")
					.setCta()
					.onClick(() => {
						void save();
					})
			);

		const runMetadataFetch = async (mode: "auto" | "test") => {
			const databaseId = parseNotionDbId(state.input);
			state.validationError = undefined;
			if (!databaseId) {
				state.status = "error";
				state.message = "Invalid Notion database URL or ID. Expected a Notion link or a 32-character hex ID.";
				renderStatus();
				updateTestButton();
				return;
			}
			draft.databaseId = databaseId;
			if (!this.plugin.settings.apiKey) {
				state.status = "notice";
				state.message = "Set Notion API key above to auto-fill DB info.";
				renderStatus();
				updateTestButton();
				return;
			}

			const requestId = ++state.requestId;
			state.status = "fetching";
			state.message = "Fetching from Notion…";
			renderStatus();
			updateTestButton();

			const client = createNotionClient(this.plugin.settings.apiKey);
			const result = await fetchDatabaseMetadata(databaseId, client);
			if (requestId !== state.requestId) return;

			if (result.ok) {
				state.status = "success";
				state.metadata = result.metadata;
				state.fetchedTitle = result.metadata.title;
				state.message = metadataMessage(result.metadata, mode === "test");
				if (shouldAutoFillDatabaseName(draft.name, state.nameTouched, this.editingId === "__new__")) {
					draft.name = result.metadata.title;
					nameInput?.setValue(draft.name);
				}
				if (!state.outputTouched && !draft.outputFolder.trim()) {
					const slug = slugify(result.metadata.title) || "database";
					draft.outputFolder = `_relay/${slug}/`;
					outputInput?.setValue(draft.outputFolder);
				}
			} else {
				state.status = "error";
				state.message = `Couldn't fetch DB info: ${result.error}`;
			}
			renderStatus();
			updateFormUx();
			updateTestButton();
		};

		function renderStatus(): void {
			statusEl.empty();
			if (state.validationError) {
				statusEl.addClass("stonerelay-error");
				statusEl.removeClass("stonerelay-success", "stonerelay-fetching", "stonerelay-notice");
				statusEl.setText(state.validationError);
				return;
			}
			statusEl.removeClass("stonerelay-error", "stonerelay-success", "stonerelay-fetching", "stonerelay-notice");
			if (state.status === "idle") return;
			statusEl.addClass(`stonerelay-${state.status}`);
			statusEl.setText(state.message);
			if (state.metadata?.rowCountApproximate) {
				statusEl.title = "Row count is estimated from the first 100 queried rows.";
			}
		}

		function updateTestButton(): void {
			testButton?.setDisabled(parseNotionDbId(state.input) === null);
		}

		const currentVaultStats = (): VaultFolderStats => {
			return this.getVaultFolderStats(draft.outputFolder.trim() || "_relay/");
		};

		function updateFormUx(): void {
			const direction = draft.direction ?? "pull";
			if (outputDescEl) {
				outputDescEl.setText(vaultFolderHelper(direction));
			}

			const vault = currentVaultStats();
			if (previewEl) {
				previewEl.empty();
				if (state.metadata) {
					for (const row of buildConnectionPreviewRows({
							direction,
							metadata: state.metadata,
							vault,
						})) {
						const rowEl = previewEl.createDiv({ cls: "stonerelay-preview-row" });
						rowEl.createSpan({ cls: "stonerelay-preview-icon", text: row.icon });
						rowEl.createSpan({ cls: "stonerelay-preview-text", text: row.text });
					}
				} else {
					const placeholder = previewEl.createDiv({ cls: "stonerelay-preview-row stonerelay-preview-placeholder" });
					placeholder.createSpan({ cls: "stonerelay-preview-icon", text: "→" });
					placeholder.createSpan({ cls: "stonerelay-preview-text", text: PREVIEW_PLACEHOLDER });
				}
			}

			if (warningsEl) {
				warningsEl.empty();
				for (const warning of formWarnings(direction, state.metadata, vault)) {
					warningsEl.createEl("div", {
						cls: "stonerelay-warning-callout",
						text: warning,
					});
				}
			}
		}

		updateFormUx();
	}

	private createEditState(input: string, fetchedTitle: string | null = null): EditState {
		return {
			input,
			fetchedTitle,
			status: "idle",
			message: "",
			nameTouched: false,
			outputTouched: false,
			requestId: 0,
		};
	}

	private getVaultFolderStats(folderPath: string): VaultFolderStats {
		const path = normalizePath(folderPath || "_relay/");
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFolder) {
			return {
				path,
				exists: true,
				markdownFiles: countMarkdownFiles(file),
			};
		}
		if (file instanceof TFile) {
			return {
				path,
				exists: true,
				markdownFiles: file.extension === "md" ? 1 : 0,
			};
		}
		return {
			path,
			exists: false,
			markdownFiles: 0,
		};
	}

	private async syncRow(entry: SyncedDatabase): Promise<void> {
		this.syncingIds.add(entry.id);
		this.display();
		await this.plugin.syncOneConfiguredDatabase(entry);
		this.syncingIds.delete(entry.id);
		this.display();
	}

	private async pushRow(entry: SyncedDatabase): Promise<void> {
		this.syncingIds.add(entry.id);
		this.display();
		await this.plugin.pushOneConfiguredDatabase(entry);
		this.syncingIds.delete(entry.id);
		this.display();
	}

	private async retryFailedRows(entry: SyncedDatabase): Promise<void> {
		this.syncingIds.add(entry.id);
		this.display();
		await this.plugin.retryFailedRows(entry);
		this.syncingIds.delete(entry.id);
		this.display();
	}

	private formatLastSync(entry: SyncedDatabase): HTMLElement {
		if (entry.lastSyncStatus === "error" || entry.lastSyncStatus === "partial") {
			const el = document.createElement("button");
			el.type = "button";
			el.setText(entry.lastSyncStatus === "partial"
				? `${entry.lastSyncErrors.length} row failures`
				: `Error: ${truncate(entry.lastSyncError || "Sync failed")}`);
			el.addClass("stonerelay-sync-error");
			el.addClass("stonerelay-sync-error-toggle");
			el.onClickEvent(() => {
				if (this.expandedErrorIds.has(entry.id)) {
					this.expandedErrorIds.delete(entry.id);
				} else {
					this.expandedErrorIds.add(entry.id);
				}
				this.display();
			});
			return el;
		}

		const el = document.createElement("span");
		if (!entry.lastSyncedAt) {
			el.setText("Never synced");
			return el;
		}

		el.setText(relativeTime(entry.lastSyncedAt));
		el.title = syncHistoryTitle(entry);
		return el;
	}
}

class ConfirmRemoveModal extends Modal {
	private name: string;
	private onConfirm: () => void;

	constructor(app: App, name: string, onConfirm: () => void) {
		super(app);
		this.name = name;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		this.contentEl.createEl("h2", {
			text: `Remove "${this.name}" from sync list?`,
		});

		new Setting(this.contentEl)
			.addButton((btn) =>
				btn
					.setButtonText("Cancel")
					.onClick(() => this.close())
			)
			.addButton((btn) =>
				btn
					.setButtonText("Remove")
					.setWarning()
					.onClick(() => {
						this.close();
						this.onConfirm();
					})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class ConflictResolutionModal extends Modal {
	constructor(
		app: App,
		private conflicts: Conflict[],
		private onUpdate: (conflicts: Conflict[]) => Promise<void>,
		private onResolveSideEffect: (conflict: Conflict, action: "pull" | "push") => Promise<void>
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.createEl("h2", { text: "Resolve conflicts" });
		if (this.conflicts.length === 0) {
			this.contentEl.createEl("p", { text: "No pending conflicts." });
			return;
		}

		for (const conflict of this.conflicts) {
			const section = this.contentEl.createDiv({ cls: "stonerelay-conflict-item" });
			section.createEl("h3", { text: `Conflict on row "${conflict.rowId}"` });
			section.createEl("p", {
				text: `Notion last edited: ${formatConflictTime(conflict.notionEditedAt)} · Vault last edited: ${formatConflictTime(conflict.vaultEditedAt)}`,
			});
			section.createEl("pre", {
				cls: "stonerelay-conflict-diff",
				text: conflictText(conflict),
			});
			new Setting(section)
				.addButton((btn) =>
					btn
						.setButtonText("Keep Notion")
						.onClick(() => void this.resolve(conflict.rowId, "keep_notion"))
				)
				.addButton((btn) =>
					btn
						.setButtonText("Keep Vault")
						.onClick(() => void this.resolve(conflict.rowId, "keep_vault"))
				)
				.addButton((btn) =>
					btn
						.setButtonText("Skip for now")
						.onClick(() => void this.resolve(conflict.rowId, "skip"))
				);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async resolve(rowId: string, choice: "keep_notion" | "keep_vault" | "skip"): Promise<void> {
		const conflict = this.conflicts.find((item) => item.rowId === rowId);
		const result = resolveManualMergeConflict(this.conflicts, rowId, choice);
		if (conflict && result.action !== "skip") {
			await this.onResolveSideEffect(conflict, result.action);
		}
		this.conflicts = result.conflicts;
		await this.onUpdate(this.conflicts);
		this.contentEl.empty();
		this.onOpen();
	}
}

class ConfirmDirectionChangeModal extends Modal {
	private previousDirection: SyncDirection;
	private nextDirection: SyncDirection;
	private onConfirm: () => void;

	constructor(app: App, previousDirection: SyncDirection, nextDirection: SyncDirection, onConfirm: () => void) {
		super(app);
		this.previousDirection = previousDirection;
		this.nextDirection = nextDirection;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		this.contentEl.createEl("h2", {
			text: "Direction change detected",
		});
		this.contentEl.createEl("p", {
			text: `This entry has been synced before with direction \`${directionName(this.previousDirection)}\`. ${directionChangeWarning(this.previousDirection, this.nextDirection)} Continue?`,
		});

		new Setting(this.contentEl)
			.addButton((btn) =>
				btn
					.setButtonText("Cancel")
					.onClick(() => this.close())
			)
			.addButton((btn) =>
				btn
					.setButtonText("Yes, change direction")
					.setWarning()
					.onClick(() => {
						this.close();
						this.onConfirm();
					})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

function requiredLabel(text: string): DocumentFragment {
	const fragment = document.createDocumentFragment();
	fragment.append(document.createTextNode(`${text} `));
	const asterisk = document.createElement("span");
	asterisk.addClass("stonerelay-required");
	asterisk.title = "Required";
	asterisk.setText("*");
	fragment.appendChild(asterisk);
	return fragment;
}

function metadataMessage(metadata: DatabaseMetadata, tested: boolean): string {
	const prefix = tested ? `✓ Connection OK: "${metadata.title}"` : `✓ Connected to "${metadata.title}"`;
	const details: string[] = [];
	if (metadata.propertyCount !== undefined) {
		details.push(`${metadata.propertyCount} properties`);
	}
	if (metadata.rowCount !== undefined) {
		details.push(`${metadata.rowCount} rows`);
	}
	return details.length > 0 ? `${prefix} · ${details.join(" · ")}` : prefix;
}

function isValidRelativePath(path: string): boolean {
	if (!path || path.startsWith("/") || path.includes("\\")) return false;
	return path.split("/").every((part) => part !== "..");
}

function relativeTime(iso: string): string {
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return iso;

	const diffMs = Date.now() - then;
	const absMs = Math.abs(diffMs);
	const minutes = Math.round(absMs / 60000);
	const hours = Math.round(absMs / 3600000);
	const days = Math.round(absMs / 86400000);

	if (minutes < 1) return "Just now";
	if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
	if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
	if (days === 1) return "Yesterday";
	return `${days} days ago`;
}

function truncate(value: string): string {
	return value.length > 80 ? `${value.slice(0, 77)}...` : value;
}

function countMarkdownFiles(folder: TFolder): number {
	return folder.children.reduce((count, child) => {
		if (child instanceof TFolder) return count + countMarkdownFiles(child);
		if (child instanceof TFile && child.extension === "md") return count + 1;
		return count;
	}, 0);
}

function directionName(direction: SyncDirection): string {
	if (direction === "push") return "Push";
	if (direction === "bidirectional") return "Bidirectional";
	return "Pull";
}

function canPush(entry: SyncedDatabase): boolean {
	return entry.direction === "push" || entry.direction === "bidirectional";
}

function directionIcon(entry: SyncedDatabase): string {
	if (entry.direction === "push") return "→";
	if (entry.direction === "bidirectional") return "⟷";
	return "←";
}

function directionLabelShort(entry: SyncedDatabase): string {
	if (entry.direction === "bidirectional") return "Pegged";
	if (entry.direction === "push") return "Push-only";
	return "Pull-only";
}

function directionLabel(direction: SyncDirection, phaseOne: boolean): string {
	if (!phaseOne) return DIRECTION_LABELS[direction];
	if (direction === "pull") return "Pull (Notion is canonical for initial seed)";
	if (direction === "push") return "Push (Obsidian is canonical for initial seed)";
	return "Bidirectional";
}

function phaseOneBidirectionalHelper(): string {
	return "Bidirectional is only available after first sync completes. Pick Pull or Push to seed the database, then flip to Bidirectional in Edit.";
}

function resolvedPathPreview(entry: SyncedDatabase): string {
	const folder = entry.outputFolder.trim() || "_relay";
	const name = entry.name.trim() || "<DB-name>";
	return entry.nest_under_db_name
		? `Files will land in: ${folder}/${name}/<file>.md`
		: `Files will land in: ${folder}/<file>.md`;
}

function renderDatabaseName(nameEl: HTMLElement, entry: SyncedDatabase): void {
	nameEl.empty();
	const url = notionDatabaseUrl(entry.databaseId);
	const target = url
		? nameEl.createEl("a", {
			cls: "stonerelay-db-name-link",
			href: url,
		})
		: nameEl.createSpan({ cls: "stonerelay-db-name-plain" });
	if (url) {
		target.setAttribute("target", "_blank");
		target.setAttribute("rel", "noopener");
		target.setAttribute("aria-label", `Open ${entry.name} in Notion`);
	}
	appendNotionLogo(target);
	target.createSpan({ text: entry.name });
	if (url) {
		target.createSpan({ cls: "stonerelay-external-link", text: "↗" });
	}
}

function appendNotionLogo(parent: HTMLElement): void {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("viewBox", "0 0 16 16");
	svg.setAttribute("aria-hidden", "true");
	svg.classList.add("stonerelay-notion-logo");
	const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
	rect.setAttribute("x", "2");
	rect.setAttribute("y", "2");
	rect.setAttribute("width", "12");
	rect.setAttribute("height", "12");
	rect.setAttribute("rx", "1.5");
	rect.setAttribute("fill", "none");
	rect.setAttribute("stroke", "currentColor");
	rect.setAttribute("stroke-width", "1.5");
	const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
	text.setAttribute("x", "8");
	text.setAttribute("y", "11");
	text.setAttribute("text-anchor", "middle");
	text.setAttribute("font-size", "8");
	text.setAttribute("font-weight", "700");
	text.setAttribute("fill", "currentColor");
	text.textContent = "N";
	svg.append(rect, text);
	parent.appendChild(svg);
}

function notionDatabaseUrl(databaseId: string): string | null {
	const normalized = databaseId.replace(/-/g, "");
	return /^[a-f0-9]{32}$/i.test(normalized) ? `https://www.notion.so/${normalized}` : null;
}

function conflictText(conflict: Conflict): string {
	return [
		"Notion snapshot:",
		JSON.stringify(conflict.notionSnapshot, null, 2),
		"",
		"Vault snapshot:",
		JSON.stringify(conflict.vaultSnapshot, null, 2),
	].join("\n");
}

function formatConflictTime(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}
