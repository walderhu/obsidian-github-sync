import { App, Notice, Plugin, PluginSettingTab, RequestUrlParam, Setting, TFile, requestUrl } from "obsidian";

interface Settings {
	owner: string;
	repository: string;
	branch: string;
	token: string;
	commitMessage: string;
	autoSyncOnOpen: boolean;
	intervalMinutes: number;
	ignorePatterns: string;
}

interface Manifest {
	version: 1;
	branch: string;
	files: Record<string, string>;
}

interface RemoteFile {
	path: string;
	sha: string;
	mode: string;
	type: string;
}

interface GitHubTreeResponse {
	sha: string;
	url: string;
	tree: RemoteFile[];
	truncated?: boolean;
}

interface GitHubCommitResponse {
	sha: string;
	tree: { sha: string };
}

interface GitHubRefResponse {
	object: { sha: string };
}

interface RemoteBlob {
	content: string;
	encoding: string;
}

interface LocalFile {
	path: string;
	bytes: ArrayBuffer;
	sha: string;
}

interface TreeEntry {
	path: string;
	mode: "100644" | "100755" | "040000" | "160000";
	type: "blob" | "tree" | "commit";
	sha: string | null;
}

const DEFAULT_SETTINGS: Settings = {
	owner: "walderhu",
	repository: "Obsidian",
	branch: "dump",
	token: "",
	commitMessage: "Sync Obsidian vault",
	autoSyncOnOpen: true,
	intervalMinutes: 0,
	ignorePatterns: [
		".git/**",
		".trash/**",
		".stfolder/**",
		".tmp.driveupload/**",
		".obsidian/workspace.json",
		".obsidian/workspace-mobile.json",
		".obsidian/plugins/obsidian-github-sync/data.json"
	].join("\n")
};

export default class GitHubVaultSyncPlugin extends Plugin {
	settings: Settings = DEFAULT_SETTINGS;
	private syncing = false;
	private intervalId?: number;

	async onload(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.sync() });
		this.addSettingTab(new GitHubVaultSyncSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(() => {
			if (this.settings.autoSyncOnOpen) void this.sync();
			this.configureInterval();
		});
	}

	onunload(): void {
		if (this.intervalId !== undefined) window.clearInterval(this.intervalId);
	}

	configureInterval(): void {
		if (this.intervalId !== undefined) window.clearInterval(this.intervalId);
		if (this.settings.intervalMinutes > 0) {
			this.intervalId = window.setInterval(() => void this.sync(), this.settings.intervalMinutes * 60_000);
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.configureInterval();
	}

	private async sync(): Promise<void> {
		if (this.syncing) return;
		if (!this.settings.token.trim()) {
			new Notice("GitHub Vault Sync: add a GitHub token in settings first.");
			return;
		}
		if (!this.settings.owner.trim() || !this.settings.repository.trim() || !this.settings.branch.trim()) {
			new Notice("GitHub Vault Sync: repository settings are incomplete.");
			return;
		}

		this.syncing = true;
		try {
			new Notice("GitHub Vault Sync: reading local and remote files…");
			const baseManifest = await this.loadManifest();
			const remote = await this.readRemoteTree();
			const local = await this.readLocalFiles();
			const merged = await this.merge(local, remote.files, baseManifest?.files ?? {});
			if (merged.entries.length === 0 && merged.downloads === 0) {
				await this.saveManifest({ version: 1, branch: this.settings.branch, files: remote.files });
				new Notice("GitHub Vault Sync: already up to date.");
				return;
			}
			if (merged.entries.length > 0) await this.pushTree(remote.commitSha, merged.entries);
			const after = await this.readRemoteTree();
			await this.saveManifest({ version: 1, branch: this.settings.branch, files: after.files });
			new Notice(`GitHub Vault Sync: complete (${merged.entries.length} remote changes, ${merged.downloads} downloaded).`);
		} catch (error) {
			console.error("GitHub Vault Sync", error);
			new Notice(`GitHub Vault Sync failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.syncing = false;
		}
	}

	private async readLocalFiles(): Promise<Map<string, LocalFile>> {
		const result = new Map<string, LocalFile>();
		for (const file of this.app.vault.getFiles()) {
			if (this.isIgnored(file.path)) continue;
			const bytes = await this.app.vault.readBinary(file);
			result.set(file.path, { path: file.path, bytes, sha: await gitBlobSha(bytes) });
		}
		return result;
	}

	private async readRemoteTree(): Promise<{ commitSha: string; files: Record<string, string> }> {
		const ref = await this.github<GitHubRefResponse>(`/repos/${this.settings.owner}/${this.settings.repository}/git/ref/heads/${encodeURIComponent(this.settings.branch)}`);
		const commitData = await this.github<GitHubCommitResponse>(`/repos/${this.settings.owner}/${this.settings.repository}/git/commits/${ref.object.sha}`);
		const tree = await this.github<GitHubTreeResponse>(`/repos/${this.settings.owner}/${this.settings.repository}/git/trees/${commitData.tree.sha}?recursive=1`);
		if (tree.truncated) throw new Error("GitHub returned a truncated tree; split the vault or use a smaller repository.");
		const files: Record<string, string> = {};
		for (const entry of tree.tree) if (entry.type === "blob") files[entry.path] = entry.sha;
		return { commitSha: ref.object.sha, files };
	}

	private async merge(local: Map<string, LocalFile>, remote: Record<string, string>, base: Record<string, string>): Promise<{ entries: TreeEntry[]; downloads: number }> {
		const entries: TreeEntry[] = [];
		let downloads = 0;
		const paths = new Set([...local.keys(), ...Object.keys(remote), ...Object.keys(base)]);
		for (const path of paths) {
			if (this.isIgnored(path)) continue;
			const localFile = local.get(path);
			const localSha = localFile?.sha;
			const remoteSha = remote[path];
			const baseSha = base[path];
			const localChanged = localSha !== baseSha;
			const remoteChanged = remoteSha !== baseSha;

			if (localSha === remoteSha) continue;
			if (localFile && !remoteSha) {
				if (baseSha && !localChanged) entries.push({ path, mode: "100644", type: "blob", sha: null });
				else entries.push({ path, mode: "100644", type: "blob", sha: await this.createBlob(localFile.bytes) });
				continue;
			}
			if (!localFile && remoteSha) {
				if (baseSha && !remoteChanged) entries.push({ path, mode: "100644", type: "blob", sha: null });
				else {
					await this.writeRemoteFile(path, remoteSha);
					downloads++;
				}
				continue;
			}
			if (localFile && remoteSha) {
				if (localChanged && !remoteChanged) {
					entries.push({ path, mode: "100644", type: "blob", sha: await this.createBlob(localFile.bytes) });
				} else if (!localChanged && remoteChanged) {
					await this.writeRemoteFile(path, remoteSha);
					downloads++;
				} else {
					const conflictPath = this.conflictPath(path);
					await this.writeRemoteFile(conflictPath, remoteSha);
					downloads++;
					entries.push({ path: conflictPath, mode: "100644", type: "blob", sha: remoteSha });
					entries.push({ path, mode: "100644", type: "blob", sha: await this.createBlob(localFile.bytes) });
				}
			}
		}
		return { entries, downloads };
	}

	private async pushTree(parentSha: string, entries: TreeEntry[]): Promise<void> {
		const tree = await this.github<{ sha: string }>(`/repos/${this.settings.owner}/${this.settings.repository}/git/trees`, {
			method: "POST",
			body: JSON.stringify({ base_tree: parentSha, tree: entries })
		});
		const commit = await this.github<{ sha: string }>(`/repos/${this.settings.owner}/${this.settings.repository}/git/commits`, {
			method: "POST",
			body: JSON.stringify({ message: `${this.settings.commitMessage} (${new Date().toISOString()})`, tree: tree.sha, parents: [parentSha] })
		});
		await this.github(`/repos/${this.settings.owner}/${this.settings.repository}/git/refs/heads/${encodeURIComponent(this.settings.branch)}`, {
			method: "PATCH",
			body: JSON.stringify({ sha: commit.sha, force: false })
		});
	}

	private async createBlob(bytes: ArrayBuffer): Promise<string> {
		const result = await this.github<{ sha: string }>(`/repos/${this.settings.owner}/${this.settings.repository}/git/blobs`, {
			method: "POST",
			body: JSON.stringify({ content: toBase64(bytes), encoding: "base64" })
		});
		return result.sha;
	}

	private async writeRemoteFile(path: string, sha: string): Promise<void> {
		const blob = await this.github<RemoteBlob>(`/repos/${this.settings.owner}/${this.settings.repository}/git/blobs/${sha}`);
		const bytes = fromBase64(blob.content);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) await this.app.vault.modifyBinary(existing, bytes);
		else {
			await this.ensureParentFolder(path);
			await this.app.vault.createBinary(path, bytes);
		}
	}

	private async ensureParentFolder(path: string): Promise<void> {
		const parts = path.split("/");
		parts.pop();
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current);
		}
	}

	private async loadManifest(): Promise<Manifest | null> {
		const data = await this.loadData();
		return data?.manifest ?? null;
	}

	private async saveManifest(manifest: Manifest): Promise<void> {
		const data = await this.loadData();
		await this.saveData(Object.assign({}, data, { manifest }));
	}

	private isIgnored(path: string): boolean {
		return this.settings.ignorePatterns.split(/\r?\n/).map((pattern) => pattern.trim()).filter(Boolean).some((pattern) => {
			const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
			return new RegExp(`^${escaped}$`).test(path);
		});
	}

	private conflictPath(path: string): string {
		const stamp = new Date().toISOString().replace(/[.:]/g, "-");
		const dot = path.lastIndexOf(".");
		return dot > 0 ? `${path.slice(0, dot)}.conflict-remote-${stamp}${path.slice(dot)}` : `${path}.conflict-remote-${stamp}`;
	}

	private async github<T = unknown>(path: string, options: Partial<RequestUrlParam> = {}): Promise<T> {
		const response = await requestUrl(Object.assign({
			url: `https://api.github.com${path}`,
			method: "GET",
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${this.settings.token.trim()}`,
				"X-GitHub-Api-Version": "2022-11-28"
			}
		}, options));
		if (response.status < 200 || response.status >= 300) throw new Error(`GitHub API ${response.status}: ${response.text.slice(0, 300)}`);
		return response.json as T;
	}
}

class GitHubVaultSyncSettingTab extends PluginSettingTab {
	plugin: GitHubVaultSyncPlugin;

	constructor(app: App, plugin: GitHubVaultSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "GitHub Vault Sync" });
		containerEl.createEl("p", { text: "Use a fine-grained GitHub token with Contents read/write access. The token is stored in this device's Obsidian plugin data and is never committed." });
		this.textSetting("GitHub owner", "walderhu", "owner", false);
		this.textSetting("Repository", "Obsidian", "repository", false);
		this.textSetting("Branch", "dump", "branch", false);
		this.textSetting("GitHub token", "github_pat_…", "token", true);
		this.textSetting("Commit message", "Sync Obsidian vault", "commitMessage", false);
		new Setting(containerEl).setName("Sync when Obsidian opens").addToggle((toggle) => toggle.setValue(this.plugin.settings.autoSyncOnOpen).onChange(async (value) => {
			this.plugin.settings.autoSyncOnOpen = value;
			await this.plugin.saveSettings();
		}));
		new Setting(containerEl).setName("Sync interval (minutes)").setDesc("0 disables the interval. iOS may pause background execution.").addText((text) => text.setValue(String(this.plugin.settings.intervalMinutes)).onChange(async (value) => {
			const minutes = Number(value);
			this.plugin.settings.intervalMinutes = Number.isFinite(minutes) && minutes >= 0 ? Math.floor(minutes) : 0;
			await this.plugin.saveSettings();
		}));
		new Setting(containerEl).setName("Ignore patterns").setDesc("One glob-like path pattern per line.").addTextArea((text) => text.setValue(this.plugin.settings.ignorePatterns).onChange(async (value) => {
			this.plugin.settings.ignorePatterns = value;
			await this.plugin.saveSettings();
		}));
	}

	private textSetting(name: string, placeholder: string, key: keyof Settings, password: boolean): void {
		new Setting(this.containerEl).setName(name).addText((text) => {
			text.setPlaceholder(placeholder).setValue(String(this.plugin.settings[key]));
			if (password) text.inputEl.type = "password";
			text.onChange(async (value) => {
				(this.plugin.settings[key] as string) = value.trim();
				await this.plugin.saveSettings();
			});
		});
	}
}

async function gitBlobSha(bytes: ArrayBuffer): Promise<string> {
	const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
	const data = new Uint8Array(header.byteLength + bytes.byteLength);
	data.set(header, 0);
	data.set(new Uint8Array(bytes), header.byteLength);
	const digest = await crypto.subtle.digest("SHA-1", data);
	return Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, "0")).join("");
}

function toBase64(bytes: ArrayBuffer): string {
	let binary = "";
	const data = new Uint8Array(bytes);
	for (let index = 0; index < data.length; index += 0x8000) binary += String.fromCharCode(...data.subarray(index, index + 0x8000));
	return btoa(binary);
}

function fromBase64(value: string): ArrayBuffer {
	const binary = atob(value.replace(/\s/g, ""));
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes.buffer;
}
