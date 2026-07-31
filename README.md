# GitHub Image Uploader

> An Obsidian plugin that uploads images to a GitHub repository as an image host and inserts accessible links automatically. Supports date-based path/filename templates, custom domains (GitHub Pages / Cloudflare Pages), and private repositories.

把图片上传到 GitHub 仓库作为图床的 Obsidian 插件：粘贴/拖入即上传，自动插入可访问链接。

## ✨ 功能特性

- 📤 **粘贴 / 拖拽即上传**：在编辑器中直接粘贴或拖入图片，自动上传并插入 `![alt](url)`。
- ⚙️ **灵活配置**：仓库、分支、路径、文件名、Token、自定义域名全部可配。
- 📅 **日期模板**：路径/文件名支持 `{year}` `{month}` `{day}` `{hour}` `{minute}` `{second}` 按时间归档与重命名。
- 🌐 **自定义域名**：支持 GitHub Pages / Cloudflare Pages 自定义域名；也支持公开仓库走 jsDelivr / raw。
- 🔧 **命令面板**：手动上传、链接转换、部署后刷新图片等命令。
- 🔒 **私有仓库友好**：私有仓库唯一对外通路为自定义域名（需 Pages 部署）。

## 📦 安装

### 方式一：下载 Release（推荐普通用户）

1. 到本仓库的 **Releases** 页面，下载 `github-image-uploader` 文件夹（内含 `main.js` + `manifest.json` + `README.md`）。
2. 把整个 `github-image-uploader/` 文件夹复制到你的笔记仓库：

   ```
   你的笔记仓库/
   └── .obsidian/
       └── plugins/
           └── github-image-uploader/   ← 放这里
               ├── main.js
               ├── manifest.json
               └── README.md
   ```

3. Obsidian → `设置` → `社区插件` → 关闭「安全模式」→ 启用 **GitHub Image Uploader**。

### 方式二：从源码编译（开发者）

```bash
git clone <本仓库地址>
cd github-image-uploader
npm install          # 若需代理：export https_proxy=http://127.0.0.1:7890
npm run build        # 产物 main.js 生成在根目录
```

然后把根目录的 `main.js` 与 `manifest.json` 拷到 `.obsidian/plugins/github-image-uploader/` 即可。

## ⚙️ 配置

启用插件后，进入 `设置` → `GitHub Image Uploader`：

| 设置项 | 说明 |
|---|---|
| **Repository** | 仓库地址，格式 `owner/repo`，如 `octocat/my-images`。 |
| **Branch** | 图片提交到的分支，默认 `main`。 |
| **Path template** | 仓库内文件夹路径。支持 `{year}` `{month}` `{day}` `{hour}` `{minute}` `{second}`，如 `images/{year}/{month}`。 |
| **Filename template** | 文件名模板。支持 `{year}` `{month}` `{day}` `{hour}` `{minute}` `{second}` `{timestamp}` `{rand}` `{name}` `{ext}`。默认含随机后缀避免重名。 |
| **GitHub Token** | 具备 `repo` 权限的个人访问令牌（PAT），用于调用 GitHub API。 |
| **Custom domain (optional)** | 自定义域名，如 `https://img.example.com`。用于 Pages 发布后访问；`URL mode` 为 `custom` 或执行转换命令时使用。 |
| **URL mode (inserted link)** | 上传后插入的链接形式（见下「私有仓库说明」）。 |

### 生成 GitHub Token

GitHub → 右上角头像 → `Settings` → `Developer settings` → `Personal access tokens` → `Tokens (classic)` → `Generate new token`，勾选 `repo` 权限 → 复制生成的令牌填入插件设置。

> 建议使用仅限图床仓库的细粒度 PAT，并妥善保管。

## 🚀 使用

- **粘贴上传**：在编辑器里 `Ctrl/Cmd + V` 粘贴图片（如截图），自动上传并插入链接。
- **拖拽上传**：把图片文件拖进编辑器，效果同上。
- **命令上传**：命令面板（`Ctrl/Cmd + P`）搜索 **`Upload image to GitHub`**，弹出文件选择器手动选图。

## 🔒 私有仓库重要说明

如果你的仓库是**私有（private）**的：

- 只能使用 `URL mode = Custom domain`（即你的 Cloudflare Pages / GitHub Pages 自定义域名），这是私有仓库唯一能对外公开访问图片的通道。
- `GitHub raw` 和 `jsDelivr` 模式**仅对公开仓库有效**；私有仓库下它们生成的链接无法匿名加载（会一直裂图）。插件已把默认 `URL mode` 设为 `custom`，私有仓库用户无需改动。
- 若你的仓库是公开的，可选用 `GitHub raw`（上传后立即可访问，不经 Pages 构建）或 `jsDelivr`（CDN）。

## ⏳ 部署延迟与「裂图」处理

通过 Cloudflare Pages / GitHub Pages 发布时，图片 push 后需等待**构建 + CDN 生效**（通常几十秒到几分钟），这段时间文档里的自定义域名链接会暂时裂图，属正常现象。

插件提供命令解决空窗：

- **`Refresh images in current note`**
  - 等部署完成后运行，强制重绘当前预览，把已部署好的图片重新拉取显示。
  - 运行：`Ctrl/Cmd + P` → 搜 `Refresh images` → 选择该命令；或给它绑快捷键（`设置` → `快捷键`）。
  - 前提：笔记需处于预览 / 阅读视图。

推荐节奏：粘贴图片 → 等约 30 秒部署完成 → 在该笔记按刷新快捷键 → 图片显示。

## 🔁 其它命令

- **`Convert image links to custom domain (current note)`**：把当前笔记中属于本仓库的 `raw` / `jsDelivr` 链接批量改写为自定义域名链接。
- **`Convert image links to custom domain (whole vault)`**：同上，作用于整个仓库所有笔记。

> 这两个命令主要给「公开仓库 + raw 即时上传、部署后再统一换域名」的场景；私有仓库一般用不到，但保留可用。

## 🧩 模板变量速查

| 变量 | 含义 | 示例 |
|---|---|---|
| `{year}` | 年份 | 2026 |
| `{month}` | 月份（两位） | 07 |
| `{day}` | 日期（两位） | 31 |
| `{hour}` | 小时（两位，24 小时制） | 16 |
| `{minute}` | 分钟（两位） | 14 |
| `{second}` | 秒（两位） | 40 |
| `{timestamp}` | 毫秒时间戳 | 1753948800000 |
| `{rand}` | 随机字符串 | a1b2c3 |
| `{name}` | 原文件名（不含扩展名） | screenshot |
| `{ext}` | 扩展名 | png |

示例路径模板：`images/{year}/{month}/{day}` → `images/2026/07/31`
示例文件名模板：`{year}{month}{day}-{hour}{minute}{second}-{rand}.{ext}`
→ 生成：`20260731-161440-x9f3k2.png`

## 🔐 安全说明

- Token 以明文保存在插件的本地数据目录（`data.json`）中，这是 Obsidian 社区插件的通用做法。请使用最小权限 PAT，并避免把该数据文件提交到任何公开仓库。
- 通过自定义域名访问的图片，其可见性取决于你的 Pages 站点权限，请按需配置。

## 🌐 English (for the Obsidian Community Plugins list)

**GitHub Image Uploader** is a free Obsidian image-hosting plugin. Paste or drop an image in your note, and it is uploaded to a GitHub repository via the GitHub Contents API. The resulting URL is inserted automatically as a Markdown image link.

Key features:

- Upload pasted / dropped / selected images to any GitHub repo.
- Configurable repo, branch, path and filename with date-based templates (`{year}`, `{month}`, `{day}`, `{hour}`, `{minute}`, `{second}`, `{timestamp}`, `{rand}`, `{name}`, `{ext}`).
- Custom domain support for GitHub Pages / Cloudflare Pages, or fall back to the jsDelivr CDN.
- Private-repo friendly: insert your custom-domain link directly; a "Refresh images" command re-renders the note once the CDN/Pages deploy finishes.

**Ready-to-use submission description (English):**

> GitHub Image Uploader is an Obsidian plugin that turns any GitHub repository into a free image host. Paste or drop an image into your note and it is uploaded via the GitHub API, with the public link inserted automatically. It supports date-based path/filename templating (year, month, day, hour, minute, second, timestamp, random), a custom domain for GitHub Pages / Cloudflare Pages (and a jsDelivr fallback), and a "Refresh images" command to re-render notes after the CDN deploy completes.

### Submitting to the community list

1. Push this repo to GitHub and make sure `main.js` + `manifest.json` are committed (the CI workflow verifies this automatically).
2. Tag a release, e.g. `1.0.0`, containing `main.js` and `manifest.json`.
3. Open a PR against <https://github.com/obsidianmd/obsidian-releases> adding your plugin to `community-plugins.json`:
   ```json
   {
     "id": "github-image-uploader",
     "name": "GitHub Image Uploader",
     "author": "workbuddy",
     "description": "Upload images pasted/dropped in Obsidian to a GitHub repo as a free image host, with date-based path templating and custom domain (GitHub Pages / Cloudflare Pages) support.",
     "repo": "YOUR_GITHUB_USERNAME/obsidian-github-image-uploader"
   }
   ```
4. Post an introduction thread on the Obsidian forum as required by the submission guide.

> Note: replace `YOUR_GITHUB_USERNAME` with your actual GitHub username.

## 📄 License

[MIT](./LICENSE) © workbuddy
