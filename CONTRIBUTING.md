# Contributing

Thanks for helping improve Apix.

## Before You Start

- Read the [development workflow](docs/development-workflow.md).
- Install the repository toolchain with `mise trust` and `mise install`.
- Install dependencies with `pnpm install`.

## Local Checks

Run the checks that match your change before opening a pull request:

```bash
pnpm check
pnpm test
```

If your change affects embedded assets or release packaging, also run:

```bash
pnpm build
```

## Pull Requests

- Keep each pull request focused on one concern.
- Include screenshots or short recordings for visible UI changes.
- Update documentation when behavior, commands, or interfaces change.
- Prefer small, reviewable commits with clear Conventional Commit messages.

## Reporting Issues

When filing a bug, include:

- What you expected to happen
- What actually happened
- Reproduction steps
- Your OS and relevant tool versions
- Logs or screenshots when they help explain the failure
