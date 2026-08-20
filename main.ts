import {
  Plugin,
  PluginSettingTab,
  Setting,
  App,
  Notice,
  Editor,
  MarkdownView,
  TFile,
  requestUrl,
} from "obsidian";

interface GitHubImageUploaderSettings {
  /** GitHub repository in the form `owner/repo`. */
  repo: string;
  /** Branch to upload to, e.g. main / master. */
  branch: string;
  /** Folder path inside the repo. Supports {year}, {month}, {day}, {hour}, {minute}, {second}. */
  pathTemplate: string;
  /** Filename pattern. Supports {year},{month},{day},{hour},{minute},{second},{timestamp},{rand},{name},{ext}. */
  filenameTemplate: string;
  /** GitHub personal access token (needs `repo` scope). */
  token: string;
  /**
   * Custom domain for GitHub Pages / Cloudflare Pages, e.g. https://img.example.com .
   * Used by URL mode "custom" and by the "convert to custom domain" command.
   */
  customDomain: string;
  /**
   * Which URL gets inserted on upload:
   *  - "raw"     → raw.githubusercontent.com (available instantly, no deploy needed)
   *  - "custom"  → your custom domain (needs Cloudflare/GitHub Pages deployed)
   *  - "jsdelivr"→ jsDelivr CDN
   * Tip: keep "raw" while writing, then run "Convert to custom domain" after deploy.
   */
  urlMode: "raw" | "custom" | "jsdelivr";
  /**
   * Behaviour on paste / drop:
   *  - "off"     → do nothing; let Obsidian handle images with its default attachment logic.
   *  - "instant" → upload each image immediately and insert the remote link (original behaviour).
   *  - "staging" → save locally to the staging folder and insert a local link; upload later in one batch.
   */
  mode: "off" | "instant" | "staging";
  /** Vault-relative folder used to stage images in "staging" mode. Added to .gitignore automatically. */
  stagingFolder: string;
}

const DEFAULT_SETTINGS: GitHubImageUploaderSettings = {
  repo: "",
  branch: "main",
  pathTemplate: "images/{year}/{month}",
  filenameTemplate: "{year}{month}{day}-{timestamp}-{rand}.{ext}",
  token: "",
  customDomain: "",
  urlMode: "custom",
  mode: "instant",
  stagingFolder: "github-image-staging",
};

export default class GitHubImageUploader extends Plugin {
  declare settings: GitHubImageUploaderSettings;

  async onload() {
    await this.loadSettings();

    this.addSettingTab(new GitHubImageUploaderSettingTab(this.app, this));

    this.addCommand({
      id: "upload-image-to-github",
      name: "Upload image to GitHub",
      editorCallback: (editor) => {
        this.openFilePicker(editor);
      },
    });

    // Intercept image paste.
    this.registerEvent(
      this.app.workspace.on(
        "editor-paste",
        (evt: ClipboardEvent, editor: Editor) => {
          this.handlePaste(evt, editor);
        }
      )
    );

    // Intercept image drag & drop.
    this.registerEvent(
      this.app.workspace.on(
        "editor-drop",
        (evt: DragEvent, editor: Editor) => {
          this.handleDrop(evt, editor);
        }
      )
    );

    // Convert raw/jsDelivr links to the custom domain once Pages has deployed.
    this.addCommand({
      id: "convert-links-custom-domain-current",
      name: "Convert image links to custom domain (current note)",
      editorCallback: () => {
        this.convertLinks(false);
      },
    });

    this.addCommand({
      id: "convert-links-custom-domain-vault",
      name: "Convert image links to custom domain (whole vault)",
      callback: () => {
        this.convertLinks(true);
      },
    });

    // After Cloudflare/GitHub Pages finished deploying, re-fetch the images
    // in the current note (the inserted custom-domain links were 404 until now).
    this.addCommand({
      id: "refresh-images-current-note",
      name: "Refresh images in current note",
      editorCallback: (editor) => {
        this.refreshImages();
      },
    });

    // Batch-upload staged (pending) images.
    this.addCommand({
      id: "upload-pending-current",
      name: "Upload pending images (current note)",
      editorCallback: () => {
        this.uploadPending(false);
      },
    });

    this.addCommand({
      id: "upload-pending-vault",
      name: "Upload pending images (whole vault)",
      callback: () => {
        this.uploadPending(true);
      },
    });
  }

  onunload() {}

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ---------- Event handlers ----------

  private async handlePaste(evt: ClipboardEvent, editor: Editor) {
    const files = evt.clipboardData?.files;
    if (!files || files.length === 0) return;
    const images = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    // Off mode: let Obsidian handle the image with its default attachment logic.
    if (this.settings.mode === "off") return;
    evt.preventDefault();
    if (this.settings.mode === "staging") {
      for (const file of images) await this.stageAndInsert(file, editor);
    } else {
      for (const file of images) await this.uploadAndInsert(file, editor);
    }
  }

  private async handleDrop(evt: DragEvent, editor: Editor) {
    const files = evt.dataTransfer?.files;
    if (!files || files.length === 0) return;
    const images = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    if (this.settings.mode === "off") return;
    evt.preventDefault();
    if (this.settings.mode === "staging") {
      for (const file of images) await this.stageAndInsert(file, editor);
    } else {
      for (const file of images) await this.uploadAndInsert(file, editor);
    }
  }

  private openFilePicker(editor: Editor) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.onchange = async () => {
      if (!input.files) return;
      for (const file of Array.from(input.files)) {
        if (this.settings.mode === "staging") {
          await this.stageAndInsert(file, editor);
        } else {
          await this.uploadAndInsert(file, editor);
        }
      }
    };
    input.click();
  }

  // ---------- Core upload ----------

  private async uploadAndInsert(file: File, editor: Editor) {
    if (!this.settings.repo || !this.settings.token) {
      new Notice(
        "GitHub Image Uploader: please set the repository and token in settings first."
      );
      return;
    }

    try {
      new Notice(`Uploading ${file.name} to GitHub...`);
      const base64 = await fileToBase64(file);
      const date = new Date();
      const path = sanitizePath(fillDateTemplates(this.settings.pathTemplate, date));
      const filename = buildFilename(
        this.settings.filenameTemplate,
        file.name,
        date
      );

      await uploadToGitHub(this.settings, path, filename, base64);

      const url = buildInsertUrl(
        this.settings,
        path,
        filename,
        this.settings.branch
      );
      const alt = file.name.replace(/\.[^.]+$/, "") || "image";
      editor.replaceSelection(`![${alt}](${url})\n`);
      new Notice(`Uploaded ${filename} successfully.`);
    } catch (e) {
      console.error(e);
      const msg = e instanceof Error ? e.message : String(e);
      new Notice(`GitHub Image Uploader: upload failed - ${msg}`);
    }
  }

  // ---------- Staging (deferred upload) ----------

  private async stageAndInsert(file: File, editor: Editor) {
    try {
      new Notice(`GitHub Image Uploader: staging ${file.name} locally...`);
      const folder =
        this.settings.stagingFolder.trim().replace(/^\/+|\/+$/g, "") ||
        "github-image-staging";
      const ext = file.name.includes(".")
        ? file.name.split(".").pop()!.toLowerCase()
        : "png";
      const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      await this.ensureStagingFolder(folder);
      const buf = await file.arrayBuffer();
      const stagingPath = `${folder}/${name}`;
      await this.app.vault.createBinary(stagingPath, buf);
      await this.ensureGitignore(folder);
      // Insert a wikilink embed. Unlike a Markdown ![](...) link, the wikilink
      // resolver walks the whole vault (including the dot-prefixed staging
      // folder) and resolves by vault path, so it renders correctly no matter
      // how deep the note lives and regardless of the hidden-folder rule.
      editor.replaceSelection(`![[${stagingPath}]]\n`);
      new Notice(
        `GitHub Image Uploader: staged ${name}. Upload later via the batch command.`
      );
    } catch (e) {
      console.error(e);
      const msg = e instanceof Error ? e.message : String(e);
      new Notice(`GitHub Image Uploader: staging failed - ${msg}`);
    }
  }

  private async ensureStagingFolder(folder: string) {
    const adapter = this.app.vault.adapter;
    if (await adapter.exists(folder)) return;
    try {
      await this.app.vault.createFolder(folder);
    } catch {
      // Already exists (race) or cannot create — staging write below will surface any real error.
    }
  }

  /**
   * If the vault is a git repository, make sure the staging folder is ignored
   * so the locally-staged images never get committed. Touches `.gitignore` only.
   */
  private async ensureGitignore(folder: string) {
    try {
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(".git"))) return; // not a git repo at vault root
      const entry = `${folder}/`;
      const exists = await adapter.exists(".gitignore");
      let content = exists ? await adapter.read(".gitignore") : "";
      const lines = content.split(/\r?\n/).map((l) => l.trim());
      if (!lines.includes(entry) && !lines.includes(folder)) {
        content =
          content.replace(/\s*$/, "") + (content.length ? "\n" : "") + `${entry}\n`;
        await adapter.write(".gitignore", content);
      }
    } catch {
      // gitignore is best-effort; staging still works without it.
    }
  }

  private computeRemote(file: TFile): {
    path: string;
    filename: string;
    rel: string;
  } {
    const date = new Date();
    const path = sanitizePath(fillDateTemplates(this.settings.pathTemplate, date));
    const filename = buildFilename(this.settings.filenameTemplate, file.name, date);
    const rel = path ? `${path}/${filename}` : filename;
    return { path, filename, rel };
  }

  /**
   * Upload every staged image referenced in the chosen scope as a SINGLE commit
   * (Git Data API: blobs -> tree -> commit -> update ref), so Cloudflare/GitHub
   * Pages only builds once. Then rewrite the local links to remote URLs and clear
   * the staging folder.
   */
  private async uploadPending(allNotes: boolean) {
    const folder =
      this.settings.stagingFolder.trim().replace(/^\/+|\/+$/g, "") ||
      "github-image-staging";

    if (!this.settings.repo || !this.settings.token) {
      new Notice(
        "GitHub Image Uploader: please set the repository and token in settings first."
      );
      return;
    }

    const active = this.app.workspace.getActiveFile();
    const mdFiles = allNotes
      ? this.app.vault.getMarkdownFiles()
      : active
      ? [active]
      : [];
    if (mdFiles.length === 0) {
      new Notice("GitHub Image Uploader: no markdown file to process.");
      return;
    }

    // 1) Staged files on disk, keyed by basename (names are unique).
    const basenameToFile = new Map<string, TFile>();
    for (const f of this.app.vault.getFiles()) {
      if (f instanceof TFile && f.path.startsWith(`${folder}/`)) {
        basenameToFile.set(f.name, f);
      }
    }

    // 2) Which staged images are referenced in this scope? Match by basename so
    //    it works with relative links, vault-root links, and wikilinks alike.
    const referenced = new Set<string>();
    const linkRe = /!\[[^\]]*\]\(([^)]+)\)|!\[\[([^\]]+)\]\]/g;
    for (const file of mdFiles) {
      const content = await this.app.vault.read(file);
      let m: RegExpExecArray | null;
      while ((m = linkRe.exec(content)) !== null) {
        const target = m[1] ?? m[2] ?? "";
        const base = linkTargetBasename(target);
        if (basenameToFile.has(base)) referenced.add(base);
      }
    }
    if (referenced.size === 0) {
      new Notice(
        "GitHub Image Uploader: no pending images found in this scope."
      );
      return;
    }

    // 3) Resolve each referenced file to its remote URL.
    const items: { rel: string; base64: string; tfile: TFile }[] = [];
    const urlByBasename = new Map<string, string>();
    const usedRels = new Set<string>();
    for (const base of referenced) {
      const af = basenameToFile.get(base)!;
      const buf = await this.app.vault.readBinary(af);
      const base64 = arrayBufferToBase64(buf);
      let { path, filename, rel } = this.computeRemote(af);
      // A second-granularity filename template without {rand} (e.g.
      // "{year}{month}{day}-{hour}{minute}{second}.{ext}") yields the SAME
      // remote path for every file processed within the same second. In a
      // single git tree those entries overwrite each other and only the last
      // image survives. Disambiguate any collision inside this batch so every
      // staged image lands at its own unique remote path.
      if (usedRels.has(rel)) {
        const dot = filename.lastIndexOf(".");
        const suffix = Math.random().toString(36).slice(2, 8);
        filename =
          dot > 0
            ? `${filename.slice(0, dot)}-${suffix}${filename.slice(dot)}`
            : `${filename}-${suffix}`;
        rel = path ? `${path}/${filename}` : filename;
      }
      usedRels.add(rel);
      const url = buildInsertUrl(
        this.settings,
        path,
        filename,
        this.settings.branch
      );
      items.push({ rel, base64, tfile: af });
      urlByBasename.set(base, url);
    }

    // 4) Single-commit batch upload.
    try {
      new Notice(
        `GitHub Image Uploader: uploading ${items.length} image(s) in one commit...`
      );
      await uploadBatch(
        this.settings,
        items.map((it) => ({ rel: it.rel, base64: it.base64 }))
      );
    } catch (e) {
      console.error(e);
      const msg = e instanceof Error ? e.message : String(e);
      new Notice(`GitHub Image Uploader: batch upload failed - ${msg}`);
      return;
    }

    // 5) Rewrite links (by basename) and delete staged files (best-effort).
    try {
      for (const file of mdFiles) {
        const content = await this.app.vault.read(file);
        const newContent = rewriteStagingLinks(content, urlByBasename);
        if (newContent !== content) {
          await this.app.vault.modify(file, newContent);
        }
      }
      for (const it of items) {
        try {
          await this.app.vault.delete(it.tfile);
        } catch {
          // keep going; a leftover staged file can be cleaned manually
        }
      }
      new Notice(
        `GitHub Image Uploader: uploaded ${items.length} image(s). Staging cleared. Wait for the deploy, then run "Refresh images".`
      );
    } catch (e) {
      console.error(e);
      const msg = e instanceof Error ? e.message : String(e);
      new Notice(
        `GitHub Image Uploader: uploaded, but failed to rewrite links - ${msg}`
      );
    }
  }

  /**
   * Rewrite raw.githubusercontent.com / jsDelivr links for THIS repo into the
   * custom domain URL, in the current note or the whole vault. Run this after
   * Cloudflare/GitHub Pages has finished deploying.
   */
  private async convertLinks(allNotes: boolean) {
    const domain = this.settings.customDomain.trim().replace(/\/+$/, "");
    if (!domain) {
      new Notice(
        "GitHub Image Uploader: set a custom domain first, then convert."
      );
      return;
    }
    const active = this.app.workspace.getActiveFile();
    const files = allNotes
      ? this.app.vault.getMarkdownFiles()
      : active
      ? [active]
      : [];
    if (files.length === 0) {
      new Notice("GitHub Image Uploader: no markdown file to convert.");
      return;
    }
    let count = 0;
    for (const file of files) {
      const content = await this.app.vault.read(file);
      let changed = false;
      const newContent = content.replace(
        /(!\[[^\]]*\]\()((?:https?:\/\/)[^)\s]+)(\))/g,
        (m, pre: string, url: string, post: string) => {
          const rel = extractRepoRel(url, this.settings);
          if (!rel) return m;
          changed = true;
          count++;
          return `${pre}${domain}/${rel}${post}`;
        }
      );
      if (changed) {
        await this.app.vault.modify(file, newContent);
      }
    }
    new Notice(
      `GitHub Image Uploader: converted ${count} image link(s) to custom domain.`
    );
  }

  /**
   * Force the active note's preview to re-render so freshly-deployed
   * (previously 404) custom-domain images get fetched.
   */
  private refreshImages() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      new Notice(
        "GitHub Image Uploader: open the note in preview/reading mode first."
      );
      return;
    }
    view.previewMode.rerender(true);
    new Notice("GitHub Image Uploader: re-rendering note images.");
  }
}

// ---------- Helpers ----------

function fillDateTemplates(template: string, date: Date): string {
  const year = date.getFullYear().toString();
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  const hour = date.getHours().toString().padStart(2, "0");
  const minute = date.getMinutes().toString().padStart(2, "0");
  const second = date.getSeconds().toString().padStart(2, "0");
  return template
    .replace(/\{year\}/g, year)
    .replace(/\{month\}/g, month)
    .replace(/\{day\}/g, day)
    .replace(/\{hour\}/g, hour)
    .replace(/\{minute\}/g, minute)
    .replace(/\{second\}/g, second);
}

function sanitize(seg: string): string {
  return seg
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[\\?*:"<>|]/g, "")
    .replace(/\/+/g, "-");
}

function sanitizePath(p: string): string {
  return p
    .split("/")
    .map((seg) => sanitize(seg))
    .filter((s) => s.length > 0)
    .join("/");
}

function buildFilename(
  template: string,
  originalName: string,
  date: Date
): string {
  const dotIdx = originalName.lastIndexOf(".");
  const ext = dotIdx > 0 ? originalName.slice(dotIdx + 1) : "";
  const name = dotIdx > 0 ? originalName.slice(0, dotIdx) : originalName;
  const rand = Math.random().toString(36).slice(2, 8);
  const ts = Date.now().toString();
  return fillDateTemplates(template, date)
    .replace(/\{timestamp\}/g, ts)
    .replace(/\{rand\}/g, rand)
    .replace(/\{name\}/g, sanitize(name))
    .replace(/\{ext\}/g, ext);
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const idx = result.indexOf(",");
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const len = bytes.length;
  for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** Relative path from `fromDir` (a folder path, "" = vault root) to `targetPath`. */
/**
 * Replace every Markdown image link or wikilink whose target basename is in
 * `urlByBasename` with `!(url)`. Used to rewrite staged (local) links to remote
 * URLs after the batch upload. Matches by basename so it works regardless of
 * whether the local link was relative, vault-root absolute, or a wikilink.
 */
function rewriteStagingLinks(
  content: string,
  urlByBasename: Map<string, string>
): string {
  return content.replace(
    /!\[[^\]]*\]\(([^)]+)\)|!\[\[([^\]]+)\]\]/g,
    (m, mdPath?: string, wikiPath?: string) => {
      const target = mdPath ?? wikiPath ?? "";
      const base = linkTargetBasename(target);
      const url = urlByBasename.get(base);
      return url ? `![](${url})` : m;
    }
  );
}

/**
 * Extract the file basename from a link target. Obsidian wikilink embeds can
 * carry a "|width" or "|display" modifier (e.g. "![[img.png|361]]"); strip the
 * "|..." part before taking the basename so lookup by filename still matches.
 */
function linkTargetBasename(target: string): string {
  const clean = target.includes("|")
    ? target.slice(0, target.indexOf("|"))
    : target;
  return clean.split("/").pop() ?? "";
}

async function uploadToGitHub(
  settings: GitHubImageUploaderSettings,
  path: string,
  filename: string,
  content: string
): Promise<void> {
  const fullPath = `${path}/${filename}`
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  const apiUrl = `https://api.github.com/repos/${settings.repo}/contents/${fullPath}`;

  const res = await requestUrl({
    url: apiUrl,
    method: "PUT",
    headers: {
      Authorization: `Bearer ${settings.token}`,
      "Content-Type": "application/json",
      "User-Agent": "obsidian-github-image-uploader",
    },
    body: JSON.stringify({
      message: `Upload image ${filename}`,
      content,
      branch: settings.branch,
    }),
  });

  if (res.status >= 400) {
    let msg = `HTTP ${res.status}`;
    try {
      if (res.json && res.json.message) msg = res.json.message;
    } catch {
      /* ignore parse errors, use status code */
    }
    throw new Error(msg);
  }
}

/**
 * Upload many images in ONE commit via the Git Data API:
 * create blobs -> create a tree -> create a commit -> update the branch ref.
 * This triggers only a single Cloudflare/GitHub Pages build.
 */
async function uploadBatch(
  settings: GitHubImageUploaderSettings,
  items: { rel: string; base64: string }[]
): Promise<void> {
  const base = `https://api.github.com/repos/${settings.repo}`;
  const headers = {
    Authorization: `Bearer ${settings.token}`,
    "Content-Type": "application/json",
    "User-Agent": "obsidian-github-image-uploader",
  };
  const branch = encodeURIComponent(settings.branch);

  const refRes = await requestUrl({
    url: `${base}/git/refs/heads/${branch}`,
    method: "GET",
    headers,
  });
  if (refRes.status >= 400) throw new Error(`get ref HTTP ${refRes.status}`);
  const latestSha: string = refRes.json.object.sha;

  const commitRes = await requestUrl({
    url: `${base}/git/commits/${latestSha}`,
    method: "GET",
    headers,
  });
  if (commitRes.status >= 400)
    throw new Error(`get commit HTTP ${commitRes.status}`);
  const baseTreeSha: string = commitRes.json.tree.sha;

  const tree: { path: string; mode: string; type: string; sha: string }[] = [];
  for (const item of items) {
    const blobRes = await requestUrl({
      url: `${base}/git/blobs`,
      method: "POST",
      headers,
      body: JSON.stringify({ content: item.base64, encoding: "base64" }),
    });
    if (blobRes.status >= 400)
      throw new Error(`create blob HTTP ${blobRes.status}`);
    tree.push({
      path: item.rel,
      mode: "100644",
      type: "blob",
      sha: blobRes.json.sha,
    });
  }

  const treeRes = await requestUrl({
    url: `${base}/git/trees`,
    method: "POST",
    headers,
    body: JSON.stringify({ base_tree: baseTreeSha, tree }),
  });
  if (treeRes.status >= 400) throw new Error(`create tree HTTP ${treeRes.status}`);
  const newTreeSha: string = treeRes.json.sha;

  const newCommitRes = await requestUrl({
    url: `${base}/git/commits`,
    method: "POST",
    headers,
    body: JSON.stringify({
      message: `Upload ${items.length} image(s) via Obsidian`,
      tree: newTreeSha,
      parents: [latestSha],
    }),
  });
  if (newCommitRes.status >= 400)
    throw new Error(`create commit HTTP ${newCommitRes.status}`);
  const newCommitSha: string = newCommitRes.json.sha;

  const updRes = await requestUrl({
    url: `${base}/git/refs/heads/${branch}`,
    method: "PATCH",
    headers,
    body: JSON.stringify({ sha: newCommitSha, force: false }),
  });
  if (updRes.status >= 400)
    throw new Error(`update ref HTTP ${updRes.status}`);
}

function buildInsertUrl(
  settings: GitHubImageUploaderSettings,
  path: string,
  filename: string,
  branch: string
): string {
  const rel = path ? `${path}/${filename}` : filename;
  const domain = settings.customDomain.trim().replace(/\/+$/, "");
  switch (settings.urlMode) {
    case "raw":
      // Available immediately after the push — no Pages build/cache needed.
      return `https://raw.githubusercontent.com/${settings.repo}/${branch}/${rel}`;
    case "jsdelivr":
      // CDN, but still has a short propagation delay for brand-new files.
      return `https://cdn.jsdelivr.net/gh/${settings.repo}@${branch}/${rel}`;
    case "custom":
    default:
      if (domain) return `${domain}/${rel}`;
      // No custom domain configured: fall back to raw so the link is usable now.
      return `https://raw.githubusercontent.com/${settings.repo}/${branch}/${rel}`;
  }
}

/**
 * If `url` is a raw/jsDelivr link for THIS repo, return its repo-relative path
 * (path/filename); otherwise return null. Used by the "convert to custom domain" command.
 */
function extractRepoRel(
  url: string,
  settings: GitHubImageUploaderSettings
): string | null {
  const repo = settings.repo; // owner/repo
  const rawPrefix = `https://raw.githubusercontent.com/${repo}/`;
  if (url.startsWith(rawPrefix)) {
    const rest = url.slice(rawPrefix.length); // branch/path
    const slash = rest.indexOf("/");
    return slash === -1 ? null : rest.slice(slash + 1);
  }
  const jdPrefix = `https://cdn.jsdelivr.net/gh/${repo}@`;
  if (url.startsWith(jdPrefix)) {
    const rest = url.slice(jdPrefix.length); // branch/path
    const slash = rest.indexOf("/");
    return slash === -1 ? null : rest.slice(slash + 1);
  }
  return null;
}

// ---------- Settings tab ----------

class GitHubImageUploaderSettingTab extends PluginSettingTab {
  plugin: GitHubImageUploader;

  constructor(app: App, plugin: GitHubImageUploader) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "GitHub Image Uploader" });

    new Setting(containerEl)
      .setName("Repository")
      .setDesc("GitHub repository in the form `owner/repo`.")
      .addText((t) =>
        t
          .setPlaceholder("owner/repo")
          .setValue(this.plugin.settings.repo)
          .onChange(async (v) => {
            this.plugin.settings.repo = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Branch")
      .setDesc("Branch the images are committed to.")
      .addText((t) =>
        t
          .setPlaceholder("main")
          .setValue(this.plugin.settings.branch)
          .onChange(async (v) => {
            this.plugin.settings.branch = v.trim() || "main";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Upload mode")
      .setDesc(
        "'Off' lets Obsidian handle pasted images with its default attachment logic. 'Instant upload' uploads each image immediately (original behaviour). 'Staging (batch later)' saves images locally and inserts local links; run 'Upload pending images' to push them all in one commit when you finish writing."
      )
      .addDropdown((d) =>
        d
          .addOption("off", "Off (Obsidian default)")
          .addOption("instant", "Instant upload")
          .addOption("staging", "Staging (batch later)")
          .setValue(this.plugin.settings.mode)
          .onChange(async (v) => {
            this.plugin.settings.mode = v as
              | "off"
              | "instant"
              | "staging";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Staging folder")
      .setDesc(
        "Vault-relative folder for staged images (used in 'Staging' mode). It is added to the vault's .gitignore automatically. Hidden by default so it stays out of the way."
      )
      .addText((t) =>
        t
          .setPlaceholder("github-image-staging")
          .setValue(this.plugin.settings.stagingFolder)
          .onChange(async (v) => {
            this.plugin.settings.stagingFolder =
              v.trim() || "github-image-staging";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Path template")
      .setDesc(
        "Folder path inside the repo. Supports {year}, {month}, {day}, {hour}, {minute}, {second}. Example: images/{year}/{month}"
      )
      .addText((t) =>
        t
          .setPlaceholder("images/{year}/{month}")
          .setValue(this.plugin.settings.pathTemplate)
          .onChange(async (v) => {
            this.plugin.settings.pathTemplate = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Filename template")
      .setDesc(
        "Supports {year},{month},{day},{hour},{minute},{second},{timestamp},{rand},{name},{ext}. A random suffix avoids collisions."
      )
      .addText((t) =>
        t
          .setPlaceholder("{year}{month}{day}-{timestamp}-{rand}.{ext}")
          .setValue(this.plugin.settings.filenameTemplate)
          .onChange(async (v) => {
            this.plugin.settings.filenameTemplate = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("GitHub Token")
      .setDesc(
        "Personal access token with `repo` scope. Stored locally in the plugin data (plaintext)."
      )
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("ghp_...")
          .setValue(this.plugin.settings.token)
          .onChange(async (v) => {
            this.plugin.settings.token = v.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Custom domain (optional)")
      .setDesc(
        "Custom domain for GitHub Pages / Cloudflare Pages, e.g. https://img.example.com . Used by URL mode 'custom' and by 'Convert to custom domain'."
      )
      .addText((t) =>
        t
          .setPlaceholder("https://img.example.com")
          .setValue(this.plugin.settings.customDomain)
          .onChange(async (v) => {
            this.plugin.settings.customDomain = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("URL mode (inserted link)")
      .setDesc(
        "'Custom domain' = your Cloudflare/GitHub Pages URL (needs the site deployed; for PRIVATE repos this is the only option that works publicly). 'GitHub raw' / 'jsDelivr' are instant but REQUIRE A PUBLIC repo and will NOT load for private repos. After deploy, run 'Refresh images in current note' to fetch them."
      )
      .addDropdown((d) =>
        d
          .addOption("raw", "GitHub raw (instant)")
          .addOption("custom", "Custom domain (after deploy)")
          .addOption("jsdelivr", "jsDelivr CDN")
          .setValue(this.plugin.settings.urlMode)
          .onChange(async (v) => {
            this.plugin.settings.urlMode = v as
              | "raw"
              | "custom"
              | "jsdelivr";
            await this.plugin.saveSettings();
          })
      );
  }
}
