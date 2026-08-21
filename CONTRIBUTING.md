# Contributing to AI Crawler Helper

Thank you for your interest in contributing to **AI Crawler Helper**! 🎉

This document outlines the workflow and guidelines for contributing to this project.

---

## 🛠️ Development Setup

### Prerequisites
- [Node.js](https://nodejs.org/) (v20.x or higher)
- [pnpm](https://pnpm.io/) (v9.x or higher)
- Google Chrome / Chromium-based browser (v125+)

### Getting Started

1. **Clone the repository**:
   ```bash
   git clone https://github.com/AiYeyeye/ai-crawler-helper-plugin.git
   cd ai-crawler-helper-plugin
   ```

2. **Install dependencies**:
   ```bash
   pnpm install
   ```

3. **Build the extension**:
   ```bash
   pnpm run build
   ```

4. **Load the extension in Chrome**:
   - Open Chrome and navigate to `chrome://extensions/`.
   - Enable **Developer mode** (top right toggle).
   - Click **Load unpacked** (加载已解压的扩展程序).
   - Select the `dist/` directory inside this repository.

---

## 🧪 Testing & Quality Gates

Before submitting a Pull Request, make sure all quality checks pass locally:

```bash
# Run unit tests
pnpm run test

# Run integration tests
pnpm run test:integration

# Type checking
pnpm run typecheck

# Linting
pnpm run lint
```

---

## 🌿 Git Branch & PR Workflow

1. **Create a feature branch**:
   ```bash
   git checkout -b feat/your-feature-name
   # or
   git checkout -b fix/your-bug-fix
   ```
2. **Commit your changes**:
   Please follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:
   - `feat: add network request filter`
   - `fix: prevent race condition on debugger disconnect`
   - `docs: update installation instructions`
   - `test: add unit test for capacity guard`

3. **Push and Open a Pull Request**:
   - Push your branch to GitHub and open a PR against the `main` branch.
   - Describe what the PR does, link any related issues, and ensure CI passes.

---

## 💬 Questions & Discussions

Feel free to ask questions, report bugs, or propose new features in [GitHub Issues](https://github.com/AiYeyeye/ai-crawler-helper-plugin/issues).

---

## 📜 Licensing Note

By contributing to this repository, you agree that your contributions will be licensed under the project's [LICENSE](./LICENSE) (Apache 2.0 with Non-Commercial Condition).
