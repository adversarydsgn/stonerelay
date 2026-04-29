export class TFile {
	path = "";
	name = "";
	basename = "";
	extension = "";
	stat = { mtime: 0 };
	parent: TFolder | null = null;
}

export class TFolder {
	path = "";
	children: unknown[] = [];
}

export class Notice {
	static messages: string[] = [];
	constructor(public message: string, public timeout?: number) {
		Notice.messages.push(message);
	}
	setMessage(message: string): void {
		this.message = message;
		Notice.messages.push(message);
	}
	hide(): void {}
}

export class Plugin {
	app: any;
	manifest: { id: string; version: string } = { id: "stonerelay", version: "0.0.0" };
	async loadData(): Promise<unknown> { return null; }
	async saveData(_data: unknown): Promise<void> {}
	addSettingTab(_tab: unknown): void {}
	registerAutoSyncWatchers(): void {}
	registerEvent(_event: unknown): void {}
	addRibbonIcon(_icon: string, _title: string, _callback: () => void): void {}
	addCommand(_command: unknown): void {}
}

export class PluginSettingTab {
	containerEl: any;
	constructor(public app: any, public plugin: any) {
		this.containerEl = createMockElement("div");
	}
	display(): void {}
}

export class Modal {
	contentEl: any = createMockElement("div");
	constructor(public app: any) {}
	open(): void { this.onOpen(); }
	close(): void { this.onClose(); }
	onOpen(): void {}
	onClose(): void {}
}

export class SuggestModal<T> extends Modal {
	setPlaceholder(_placeholder: string): void {}
	getSuggestions(_query: string): T[] { return []; }
	renderSuggestion(_value: T, _el: HTMLElement): void {}
	onChooseSuggestion(_value: T): void {}
}

export class ButtonComponent {
	buttonEl = createMockElement("button");
	setButtonText(text: string): this {
		this.buttonEl.textContent = text;
		return this;
	}
	setIcon(_icon: string): this { return this; }
	setCta(): this { return this; }
	setWarning(): this { return this; }
	setDisabled(disabled: boolean): this {
		this.buttonEl.disabled = disabled;
		return this;
	}
	onClick(callback: () => void): this {
		this.buttonEl.onClickEvent(callback);
		return this;
	}
}

export class Setting {
	settingEl = createMockElement("div");
	descEl = createMockElement("div");
	controlEl = createMockElement("div");
	constructor(public containerEl: any) {}
	setName(name: string): this {
		this.settingEl.createEl("div", { text: name });
		return this;
	}
	setDesc(desc: string): this {
		this.descEl.setText(desc);
		return this;
	}
	addText(_callback: (component: any) => void): this {
		_callback(textComponent());
		return this;
	}
	addTextArea(_callback: (component: any) => void): this {
		_callback(textComponent());
		return this;
	}
	addToggle(_callback: (component: any) => void): this {
		_callback({ setValue: () => ({ onChange: () => undefined }), onChange: () => undefined });
		return this;
	}
	addDropdown(_callback: (component: any) => void): this {
		_callback({ addOption: () => undefined, setValue: () => ({ onChange: () => undefined }), onChange: () => undefined });
		return this;
	}
	addButton(_callback: (component: ButtonComponent) => void): this {
		const button = new ButtonComponent();
		_callback(button);
		this.controlEl.children.push(button.buttonEl);
		this.containerEl.children?.push(button.buttonEl);
		return this;
	}
}

export function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

export function addIcon(): void {}

export function setIcon(el: { setAttribute?: (name: string, value: string) => void }, icon: string): void {
	el.setAttribute?.("data-icon", icon);
}

export async function requestUrl(): Promise<never> {
	throw new Error("requestUrl is not available in tests");
}

function textComponent() {
	const component = {
		inputEl: createMockElement("input"),
		setPlaceholder: (placeholder: string) => {
			component.inputEl.placeholder = placeholder;
			return component;
		},
		setValue: (value: string) => {
			component.inputEl.value = value;
			return component;
		},
		then: (callback: (value: typeof component) => void) => {
			callback(component);
			return component;
		},
		onChange: (callback: (value: string) => void) => {
			component.inputEl.onChange = callback;
			return component;
		},
	};
	return component;
}

function createMockElement(tag: string): any {
	return {
		tag,
		children: [] as any[],
		textContent: "",
		listeners: new Map<string, () => void>(),
		classList: { add: () => undefined, remove: () => undefined },
		addClass: () => undefined,
		removeClass: () => undefined,
		hide: () => undefined,
		setAttribute: () => undefined,
		addEventListener(event: string, callback: () => void) {
			this.listeners.set(event, callback);
		},
		onClickEvent(callback: () => void) {
			this.listeners.set("click", callback);
		},
		setText(text: string) {
			this.textContent = text;
		},
		createDiv(options?: { cls?: string }) {
			const child = createMockElement("div");
			child.cls = options?.cls;
			this.children.push(child);
			return child;
		},
		createEl(childTag: string, options?: { text?: string; cls?: string; href?: string }) {
			const child = createMockElement(childTag);
			child.textContent = options?.text ?? "";
			child.cls = options?.cls;
			child.href = options?.href;
			this.children.push(child);
			return child;
		},
		createSpan(options?: { text?: string; cls?: string }) {
			const child = createMockElement("span");
			child.textContent = options?.text ?? "";
			child.cls = options?.cls;
			this.children.push(child);
			return child;
		},
		empty() {
			this.children = [];
		},
	};
}
