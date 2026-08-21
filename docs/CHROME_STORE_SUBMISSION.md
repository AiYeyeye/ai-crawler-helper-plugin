# Chrome Web Store 上架完整资料与提交指南

本文档为 `AI Crawler Helper` 发布到 **Google Chrome Web Store（Chrome 应用商店）** 的全套准备物料。在开发者后台（[Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)）提交审核时，可直接复制以下中英文文案与隐私权限回答。

---

## 📋 一、 商店基本信息（Store Listing Info）

### 1. 扩展基本信息
- **扩展名称 (Item Name)**: `AI Crawler Helper`
- **简短描述 (Summary / Short Description)** (限制 <= 132 字符):
  - **英文**: `100% local-first browser recorder capturing scoped DOM, CDP network requests, and user actions for AI crawler development.` (119 字符)
  - **中文**: `完全本地运行的浏览器录制器，精准抓取局部 DOM、CDP 网络请求与用户操作，一键导出供 AI 生成爬虫。` (50 字符)
- **类别 (Category)**: `Developer Tools`（开发者工具） / `Productivity`（生产力工具）
- **主要语言 (Primary Language)**: `English` (或 `Chinese (Simplified)`)

---

### 2. 详细描述 (Detailed Description)

在商店后台 **"Detailed Description"** 文本框中可直接粘贴以下 Markdown/纯文本内容：

```text
AI Crawler Helper is a 100% local-first, privacy-focused Chrome Manifest V3 extension designed to streamline web scraping and automated crawler development.

When exploring target websites manually, AI Crawler Helper faithfully captures user interactions, scoped DOM subtrees, local mutations, navigation lifecycle events, CDP-grade network requests/responses, and cookie/storage transitions into discrete, sequential "Steps".

Exported fact packages (structured ZIP / JSON) can be fed directly to AI coding agents (such as Claude, GPT-4, and DeepSeek) or used by automation engineers to generate robust, production-ready Playwright, Puppeteer, or Scrapy crawlers.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✨ KEY FEATURES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🔒 100% Local-First & Zero Telemetry
All data is stored exclusively in your browser's local IndexedDB. There are no backend servers, no cloud syncing, no telemetry, and no third-party tracking.

🎯 Step-Centric Interaction Recording
Groups clicks, text inputs, form submits, scoped DOM changes, and triggered network calls into coherent, chronological steps.

🌐 CDP-Grade Network Interception
Leverages the Chrome DevTools Protocol (CDP Network Domain) via chrome.debugger to record real HTTP/HTTPS headers, status codes, query parameters, cookies, and response payloads.

🌳 Scoped DOM & Mutation Tracking
Unlike heavy full-page scrapers, it records only the interacted element's subtree, its parent chain to <body>, and localized mutations, ensuring high signal-to-noise ratio.

📦 AI-Ready Fact Packages
Export versioned ZIP packages containing full request bodies, storage diffs, and an LLM-readable INDEX.md fact summary ready for one-click prompt generation.

🛡️ Safe Memory & Quota Guard
Real-time storage pressure monitoring automatically pauses recording before hitting browser quota limits.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔒 PRIVACY & SECURITY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- Ground-truth data stays entirely on your local machine.
- Explicit warnings are displayed before starting recording sessions and exporting fact archives.
- Open Source Repository: https://github.com/AiYeyeye/ai-crawler-helper-plugin
- Privacy Policy: https://github.com/AiYeyeye/ai-crawler-helper-plugin/blob/main/PRIVACY.md
- Contact & Support: supercomputing@agent.qq.com
```

---

## 🛡️ 二、 隐私合规与权限审核声明（Privacy Practices & Justifications）

> [!IMPORTANT]
> Chrome Web Store 对使用了 `debugger`、`cookies`、`storage`、`tabs` 等高权限的扩展审核极其严格。以下是针对审核团队的标准声明文案（直接复制提交）：

### 1. 单一用途说明 (Single Purpose Description)
> **英文填入内容**:
> *"The single purpose of AI Crawler Helper is to locally record and export ground-truth browser interaction facts (scoped DOM subtrees, CDP network events, user clicks/inputs, and storage state transitions) to assist developers in generating web crawler scripts and automation test cases."*

---

### 2. 权限合理性详细说明 (Permission Justifications)

在后台每个权限下方的说明框中填入：

| 权限 (Permission) | 审核解释理由 (Justification for Reviewers) |
| :--- | :--- |
| **`debugger`** | *"Required to attach the Chrome DevTools Protocol (CDP Network domain) to the active recording tab to faithfully capture complete HTTP/HTTPS requests, response headers, status codes, and response bodies that standard extension APIs cannot capture."* |
| **`cookies`** | *"Required to observe domain cookie mutations and session authentication states before and after user interactions to provide full context for crawler reproduction."* |
| **`storage` / `unlimitedStorage`** | *"Required to persist recorded session events, scoped DOM trees, and network payloads locally in the browser's IndexedDB without premature quota eviction."* |
| **`activeTab` / `tabs`** | *"Required to identify the user's selected recording target tab and monitor tab status during the active recording lifecycle."* |
| **`webNavigation`** | *"Required to detect document commits, page navigations, frame transitions, and redirects across discrete recording steps."* |
| **`sidePanel`** | *"Required to provide an unobtrusive companion interface alongside the target webpage for viewing real-time recording timelines and step statistics."* |
| **`offscreen`** | *"Required to compress and assemble structured ZIP fact packages in an asynchronous background context without blocking or freezing the main user interface."* |
| **`downloads`** | *"Required to save the exported fact package (ZIP or JSON file) directly to the user's local disk upon their explicit export action."* |
| **`scripting`** | *"Required to inject local interaction listeners (click, input, scroll) and DOM MutationObservers into the target recording page."* |

---

### 3. 宿主权限合理性说明 (Host Permissions Justification)
- **申请的权限**: `host_permissions`: `http://*/*`, `https://*/*`, `file:///*`
- **审核解释理由 (Justification)**:
  > *"Users need to record interaction facts, CDP network requests, and DOM mutations on arbitrary user-specified websites for crawling and automation testing purposes."*

---

### 4. 数据使用问卷勾选 (Data Usage Declaration)
在后台 **Privacy practices** 问卷中：
1. **Does your extension collect user data?**
   - 勾选: **No**, the extension does not collect or transmit user data to external servers. All data is processed and stored 100% locally.
2. **Certification**:
   - 勾选: *"I certify that this extension complies with the Limited Use Policy."*
   - 勾选: *"I confirm that data is not sold or transferred for purposes unrelated to the extension's core functionality."*
3. **Privacy Policy URL**:
   - 填入: `https://github.com/AiYeyeye/ai-crawler-helper-plugin/blob/main/PRIVACY.md`

---

## 🎨 三、 商店视觉物料清单（Assets Checklist）

| 物料类型 | 尺寸与格式要求 | 状态与路径 |
| :--- | :--- | :---: |
| **商店主图标 (Store Icon)** | `128x128 PNG` | ✅ 已就绪: `public/icons/icon-128.png` |
| **高清宣传图标 (Hi-res Icon)** | `512x512 PNG` | ✅ 已就绪: `public/icons/icon-512.png` |
| **扩展界面截图 (英文版 · 推荐国际商店上传)** | `1280x800 PNG` | ✅ 已生成 3 张英文版 (文字绝无遮挡):<br/>1. `docs/images/webstore-screenshot-1-en.png`<br/>2. `docs/images/webstore-screenshot-3-en.png`<br/>3. `docs/images/webstore-screenshot-2-en.png` |
| **扩展界面截图 (中文版 · 适合中文区商店或展示)** | `1280x800 PNG` | ✅ 已生成 3 张中文版 (文字绝无遮挡):<br/>1. `docs/images/webstore-screenshot-1-zh.png`<br/>2. `docs/images/webstore-screenshot-3-zh.png`<br/>3. `docs/images/webstore-screenshot-2-zh.png` |
| **小宣传横幅 (Small Promo Tile)** *(可选)* | `440x280 PNG` | 🎨 可选展示 |
| **大宣传横幅 (Marquee Tile)** *(可选)* | `1400x560 PNG` | 用于推荐位展示 |

---

## 🚀 四、 提交上架 4 步走实操流程

1. **第 1 步：准备发布安装包**
   - 直接下载 GitHub 自动打包好的：[ai-crawler-helper-plugin-v0.1.0.zip](https://github.com/AiYeyeye/ai-crawler-helper-plugin/releases/tag/v0.1.0)
2. **第 2 步：登录开发者控制台**
   - 打开 [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
   - （首次使用需支付 $5 注册开发者账号）
3. **第 3 步：上传与填写资料**
   - 点击 **"Add new item"（添加新商品）**，上传 `ai-crawler-helper-plugin-v0.1.0.zip`。
   - 按照本文档 **第一节** 填写商品信息、上传截图与图标。
   - 按照本文档 **第二节** 填写隐私问卷与权限合理性理由。
4. **第 4 步：提交审核（Submit for Review）**
   - 审核通常在 1~3 个工作日内完成，审核通过后插件将自动在 Chrome 应用商店上线！
