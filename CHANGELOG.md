# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.0] - 2026-08-21

### Added
- **Core Recording Engine**:
  - Step-centric recording lifecycle and state machine.
  - Minimal scoped DOM subtree and parent-chain serialization with mutation observer support.
  - Full CDP Network capture via `chrome.debugger` API (headers, cookies, status, payloads).
  - Storage & Cookie snapshot diffing across discrete user steps.
- **Export & Storage**:
  - Deterministic versioned fact packages exported as structured ZIP archives or single JSON.
  - Human- and LLM-readable `INDEX.md` and prompt generation for AI agents (Claude, ChatGPT, DeepSeek).
  - High-performance asynchronous ZIP compression using Chrome MV3 `offscreen` documents.
  - Storage pressure monitor and Capacity Guard to prevent browser crashes.
- **User Interface**:
  - Chrome SidePanel interface for live step inspection, session status, and review.
  - Extension Popup for quick session start, pause, and stop controls.
  - Comprehensive quality view for capture gaps and warnings.
- **Open Source Standards**:
  - GitHub Actions CI workflow (linting, type checking, unit tests, integration tests, build).
  - Standard community health files (`CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `PRIVACY.md`, `LICENSE`, Issue & PR templates).
  - Official icons in 16x16, 32x32, 48x48, 128x128, 512x512 PNG formats.
