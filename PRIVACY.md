# Privacy Policy for AI Crawler Helper

**Last Updated**: 2026-08-21

`AI Crawler Helper` ("the Extension", "we", "our") is an open-source browser extension designed to assist developers in recording browser interactions and exporting structured web facts for crawler development and automation testing.

We are committed to protecting your privacy. This Privacy Policy explains how data is handled by the Extension.

---

## 1. Core Principle: 100% Local Processing

- **No Remote Servers**: The Extension does **not** operate any backend servers, cloud databases, or API proxies.
- **No Telemetry or Tracking**: The Extension does **not** collect telemetry, analytics, crash reports, or user behavior metrics.
- **No Data Monetization or Sharing**: We do **not** sell, transmit, share, or monetize any user data.

---

## 2. Data Handled by the Extension

All data captured by the Extension is stored strictly inside your browser's local storage (**IndexedDB** via standard Web APIs) and never leaves your computer unless you explicitly export it.

### What is Recorded:
When you explicitly initiate a recording session on a specific browser tab:
1. **User Actions**: Click events, input changes, key presses, scrolling, and navigation events.
2. **DOM Subtrees**: Scoped DOM trees and mutations associated with the target elements you interacted with.
3. **Network Activity**: HTTP/HTTPS requests and responses (headers, status codes, request/response bodies) captured via Chrome's Debugger API (`CDP Network domain`).
4. **Storage State**: LocalStorage, SessionStorage, and Cookie states relevant to the recorded domain.

---

## 3. Chrome Permissions Justification

In compliance with the Chrome Web Store Developer Program Policies, here is why each permission is required:

| Permission | Justification / Purpose |
| :--- | :--- |
| `debugger` | Required to attach Chrome DevTools Protocol (CDP) to the target recording tab to accurately capture network requests, headers, and responses. |
| `activeTab` / `tabs` | Required to identify the target tab, manage recording states, and track page navigations. |
| `cookies` | Required to inspect cookie state transitions during recorded navigation. |
| `storage` / `unlimitedStorage` | Required to store recorded sessions, events, and fact packages locally in browser IndexedDB. |
| `webNavigation` | Required to track page transitions, redirects, and document lifecycle events during a session. |
| `sidePanel` | Required to display the recording control panel and live timeline in Chrome's side panel. |
| `offscreen` | Required to generate and compress exported ZIP packages asynchronously without freezing the user interface. |
| `downloads` | Required to save exported JSON/ZIP fact packages directly to your local file system upon your explicit request. |
| `scripting` | Required to inject local interaction and mutation observers into the recorded web page. |

---

## 4. Sensitive Data & Security

- **Credentials and Tokens**: During network and cookie capture, sensitive information (such as authorization headers, session cookies, and form values) may be present in the recorded facts.
- **User Responsibility**: The Extension displays explicit warnings before recording and exporting. You are responsible for inspecting and sanitizing exported files before sharing them with third parties or AI tools.

---

## 5. Third-Party Services

The Extension does not bundle any third-party advertising SDKs, tracking libraries, or analytics scripts.

---

## 6. Updates to This Policy

We may update this Privacy Policy to reflect changes in extension features or browser policies. Any revisions will be updated directly in this repository.

---

## 7. Contact & Vulnerability Reporting

If you have questions regarding this Privacy Policy or wish to report a security concern, please contact us at `supercomputing@agent.qq.com` or refer to [SECURITY.md](./SECURITY.md).
