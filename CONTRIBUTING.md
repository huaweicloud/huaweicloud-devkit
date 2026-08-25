# Contributing to Huawei Cloud DevKit

Thank you for your interest in contributing to the Huawei Cloud DevKit plugin.

Please take a moment to read the contribution guidelines below before opening issues or pull requests.

## Table of Contents

- [Development Model](#development-model)
- [Setting Up](#setting-up)
- [Code of Conduct](#code-of-conduct)
- [Commit Guidelines](#commit-guidelines)
- [Pull Request Process](#pull-request-process)
- [CI Requirements](#ci-requirements)
- [Testing](#testing)
- [npm Publishing Rules](#npm-publishing-rules)
- [Release Process](#release-process)
- [Reporting Bugs](#reporting-bugs)
- [Feature Requests](#feature-requests)
- [Security](#security)

## Development Model

- **`dev`** is the development branch. All feature work happens here.
- **`main`** is the stable branch. It only receives changes merged from `dev` and is the source of npm `latest` releases.
- **Never** commit directly to `main`.

## Setting Up

```bash
git clone git@github.com:huaweicloud/huaweicloud-devkit.git
cd huaweicloud-devkit
npm install

# local checks
npm test          # run all tests
npm run validate  # structural validation
npm run lint      # markdown lint
```

Requires Node.js >= 22.

## Code of Conduct

Please note that this project is released with a [Contributor Code of Conduct](CODE_OF_CONDUCT.md). By participating in this project you agree to abide by its terms.

## Commit Guidelines

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>
```

Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `ci`, `security`.

Examples:

```
feat(ecs): add instance resize workflow
fix: correct OBS error code mapping
security(auth): prevent credential leakage in shell history
```

Pull request titles must follow the same convention (enforced by CI).

## Pull Request Process

1. Create a branch from `dev` for your change.
2. Push your branch and open a pull request **targeting `dev`**.
3. All CI checks must pass (see [CI Requirements](#ci-requirements)).
4. A maintainer reviews and merges the pull request.
5. Changes reach `main` through a separate `dev` → `main` merge pull request.

## CI Requirements

Every pull request runs automated checks. All must pass before merging:

- **PR Lint** — conventional commit title
- **CI** — markdownlint, `npm test`, `npm run validate`, `npm audit`, gitleaks secret scan
- **CodeQL** — static security analysis

Do not bypass, disable, or relax these checks. If a check fails, fix the underlying issue.

## Testing

- Run `npm test` locally before pushing.
- When you introduce new invariants (e.g., required SKILL.md structure), add corresponding tests under `test/`.
- Keep existing tests green.

## npm Publishing Rules

**npm packages are only published through GitHub Actions workflows. Never run `npm publish` from an agent or local shell.**

- **Do not** run `npm publish`, `npm version`, or `npm dist-tag`.
- **Do not** modify the `version` field in `package.json`, `package-lock.json`, or `**/plugin.json`.
- **Do not** create or push git tags manually.
- The `dev` branch version must always be a prerelease (`0.1.x-dev.n`). Formal versions (`0.1.x`) are produced only by the `main` release flow.

To request a release, trigger the appropriate workflow in GitHub Actions:

- Test package: `Publish Dev (next)` on the `dev` branch → publishes as dist-tag `next`.
- Formal package: `Prepare Release` + `Publish Release` on `main` → publishes as dist-tag `latest`.

## Release Process

Two channels, fully managed by GitHub Actions:

| Channel | Branch | Workflow                              | dist-tag | Version       |
| ------- | ------ | ------------------------------------- | -------- | ------------- |
| Test    | `dev`  | `Publish Dev (next)`                  | `next`   | `0.1.x-dev.n` |
| Stable  | `main` | `Prepare Release` / `Publish Release` | `latest` | `0.1.x`       |

## Reporting Bugs

- Search existing issues first.
- Open an issue with: a clear title, steps to reproduce, expected vs actual behavior, and your environment (OS, agent, version).

## Feature Requests

- Open an issue describing the feature and your use case.

## Security

If you discover a security vulnerability, do **not** open a public issue. Report it privately to the maintainers (see [SECURITY.md](SECURITY.md)).
