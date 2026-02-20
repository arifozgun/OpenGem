# Contributing to OpenGem

Thank you for your interest in contributing to OpenGem! This document provides guidelines and instructions for contributing.

## Getting Started

1. **Fork** the repository on GitHub.
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/your-username/OpenGem.git
   cd OpenGem
   ```
3. **Install** dependencies:
   ```bash
   npm install
   ```
4. **Create a branch** for your feature or fix:
   ```bash
   git checkout -b feature/your-feature-name
   ```

## Development

```bash
# Start the development server with hot-reload
npm run dev

# Build for production
npm run build
```

## Code Guidelines

- Write clean, readable TypeScript.
- Follow the existing code style and structure.
- Keep functions focused and small.
- Add comments for non-obvious logic.

## Commit Messages

Use clear and descriptive commit messages:

```
feat: add streaming response support
fix: resolve token refresh race condition
docs: update API usage examples
refactor: simplify load balancer logic
```

## Pull Request Process

1. Ensure your code builds without errors (`npm run build`).
2. Update documentation if your changes affect the public API or setup process.
3. Write a clear PR description explaining **what** changed and **why**.
4. Link any related issues.

## Reporting Bugs

Open an issue on GitHub with:
- A clear title and description.
- Steps to reproduce the bug.
- Expected vs. actual behavior.
- Node.js version and operating system.

## Feature Requests

Open an issue with the **enhancement** label. Describe:
- The problem your feature would solve.
- Your proposed solution.
- Any alternatives you considered.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
