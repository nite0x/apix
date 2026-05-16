# Development Workflow

This repository uses a lightweight branch-based workflow so that `main` stays
stable while feature work remains easy to review and roll back.

## Branch Strategy

- `main`
  - Always keeps the latest stable code.
  - Should stay buildable and suitable for release.
  - Receives completed work through merges from short-lived branches.
- Working branches
  - Use one branch per task.
  - Keep branches focused and short-lived.
  - Delete them after they are merged.

## Branch Naming

Use lowercase names with `/` as the separator.

```text
feature/<short-description>
fix/<short-description>
docs/<short-description>
refactor/<short-description>
chore/<short-description>
```

Examples:

```text
feature/session-search
fix/websocket-reconnect
docs/development-workflow
refactor/runtime-router
chore/update-tooling
```

## Commit Messages

Prefer Conventional Commit style:

```text
feat: add session filtering
fix: prevent duplicate websocket reconnects
docs: add development workflow guide
refactor: split runtime route handlers
chore: update build tooling
```

Common prefixes:

- `feat`: new user-facing capability
- `fix`: bug fix
- `docs`: documentation only
- `refactor`: internal restructuring without changing behavior
- `test`: tests only
- `chore`: maintenance work

## Recommended Daily Workflow

Start from the latest `main`:

```bash
git switch main
git pull origin main
```

Create a task branch:

```bash
git switch -c feature/session-search
```

Develop and commit in small logical steps:

```bash
git add .
git commit -m "feat: add session search input"
```

Before merging, run the relevant checks:

```bash
pnpm typecheck
pnpm build:web
```

If the change touches the desktop shell or runtime integration, also run:

```bash
pnpm build
```

Merge completed work back into `main`:

```bash
git switch main
git pull origin main
git merge --no-ff feature/session-search
git push origin main
```

After the merge:

```bash
git branch -d feature/session-search
```

## Pull Request Guidance

Use a pull request when:

- The change is large or risky.
- You want review history.
- More than one person is collaborating.
- The branch should be discussed before landing.

The preferred GitHub flow is:

```text
working branch -> pull request -> merge into main -> push/release from main
```

## Merge Guidance

- Prefer `--no-ff` merges for larger features so the branch history remains
  visible.
- Keep `main` clean; avoid half-finished work there.
- Rebase a local working branch only before it is shared with others.
- Do not force-push shared branches unless the team has explicitly agreed to
  that cleanup.

## Hotfixes

For urgent production fixes:

```bash
git switch main
git pull origin main
git switch -c fix/critical-runtime-crash
```

After verification, merge the fix back into `main` promptly and push it.

## Repository Setup Note

Before this workflow can be used with GitHub, configure a remote named
`origin`:

```bash
git remote add origin <github-repository-url>
git push -u origin main
```
