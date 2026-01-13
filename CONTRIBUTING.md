# Contributing to Ping6.it

Thanks for your interest in contributing! Ping6.it is an experimental project focused on comparing IPv4 vs IPv6 reachability and performance measurements.

## Ways to contribute

- **Report bugs** (UI issues, wrong results, edge cases, regressions)
- **Suggest features** (new measurements, better UX, documentation improvements)
- **Improve docs** (README, usage examples, FAQs)
- **Submit code changes** (bug fixes, refactors, new features)

## Before you start

- Search existing **issues** and **pull requests** to avoid duplicates.
- For larger changes, open an issue first to discuss scope and approach.

## Development setup

> The exact commands may vary slightly depending on the repo tooling, but this is the typical workflow.

### Prerequisites

- **Node.js** (LTS recommended)
- **npm** (or pnpm/yarn if the project uses it)

### Install dependencies

```bash
npm install
```

### Run the dev server

```bash
npm run dev
```

### Build

```bash
npm run build
```

### Preview the production build

```bash
npm run preview
```

## Project conventions

### Code style

- Keep changes **small and focused**.
- Prefer **readability over cleverness**.
- Avoid unrelated formatting changes in the same PR.
- Use descriptive names and add comments only when necessary.

### UI/UX

- Preserve accessibility where possible (keyboard navigation, focus styles).
- Keep copy **short and clear** (English only).

### Performance and correctness

- Avoid unnecessary network calls.
- Be careful with timeouts, retries, and error handling.
- Do not log or expose sensitive data (tokens, user identifiers).

## Measurements and external APIs

If your change touches measurements or API calls:

- Document the expected request/response behavior in the PR description.
- Handle partial failures gracefully (some probes may fail).
- Prefer deterministic logic (avoid random behavior unless it’s part of the feature, and if so, explain it).

## Commit messages

Use clear, descriptive commit messages. Suggested format:

- `feat: add <thing>`
- `fix: resolve <bug>`
- `docs: update <section>`
- `refactor: simplify <module>`

## Pull request process

1. **Fork** the repository and create a branch:
   - `git checkout -b feat/my-change` or `fix/my-bug`
2. Make your changes and ensure the app still runs locally.
3. Update documentation if behavior changes.
4. Open a PR with:
   - What changed and why
   - Screenshots/GIFs for UI changes (when applicable)
   - Any relevant issue links (e.g., `Fixes #123`)

### PR checklist

- [ ] I ran the app locally and verified the change
- [ ] I added/updated docs if needed
- [ ] I kept the PR focused (no unrelated changes)
- [ ] I explained edge cases and limitations

## Reporting security issues

Please **do not** open public issues for security vulnerabilities.

Instead, report privately to: **antonio@prado.it**

Include:
- Steps to reproduce
- Impact assessment
- Any suggested fix (if available)

## License

By contributing, you agree that your contributions will be licensed under the same license as the project.
