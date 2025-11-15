# Copilot Coding Agent Onboarding Guide

## Repository Overview

This repository, `society-bot`, is a TypeScript/Node.js project for Fame Lady Society. It provides automation, data processing, and bot-related functionality for the Fame ecosystem. The codebase is moderate in size and primarily uses TypeScript, with some shell scripts and JSON data files. It is not a web app, but a backend/bot utility project.

## High-Level Details

- **Primary Language:** TypeScript (ES modules)
- **Runtime:** Node.js (>=18 recommended)
- **Key Tools:** Jest (testing), ts-node, TypeScript, shell scripts
- **Package Manager:** npm or yarn (yarn preferred)
- **Linting:** ESLint
- **Testing:** Jest
- **CI:** GitHub Actions (if present)

## Build & Validation Instructions

### 1. Bootstrap/Install

- **Always run `yarn` before any build, test, or run step.**

### 2. Build

- This project is TypeScript-based but does not require a separate build step for most scripts (uses ts-node or runs directly via tsconfig paths).
- If a build is needed, check for a `build` script in `package.json` (e.g., `yarn build`).

### 3. Lint

- Run `yarn lint` to check code style and catch errors early.
- Lint config: `.eslintrc` or similar in the root.

### 4. Test

- Run `yarn test` to execute the Jest test suite.
- Tests are located in the `tests/` directory.
- If you encounter missing type errors, ensure all dependencies are installed and try cleaning `node_modules` and reinstalling.

### 5. Run

- Main scripts are in `src/`.
- Use `yarn start` or check `package.json` for custom run scripts.
- Some scripts may be run directly with `ts-node` (e.g., `npx ts-node src/foo.ts`).

### 6. Clean

- If you encounter build or type errors, try:
  - `rm -rf node_modules && yarn install`
  - Remove any generated files in `out.js`, `output.mjpeg`, etc.

### 7. Validation

- Always run lint and test before submitting changes.
- If a GitHub Actions workflow exists, ensure your branch passes all checks before merging.

## Project Layout

- **Root files:**
  - `package.json` – scripts, dependencies
  - `tsconfig.json` – TypeScript config
  - `jest.config.js` – Jest config
  - `README.md` – project overview
  - `copilot-instructions.md` – this file
  - `LICENSE`, `data.json`, `out.js`, `output.mjpeg`, etc.
- **Key directories:**
  - `src/` – main source code
  - `tests/` – test files
  - `abi/` – contract ABIs
  - `deploy/` – deployment scripts
  - `images/`, `videos/` – media assets
- **Scripts:**
  - `convert.sh`, `test.sh` – shell helpers

## CI & Validation

- If `.github/workflows/` exists, GitHub Actions will run lint and test on PRs.
- Always ensure your changes pass these checks.

## Additional Notes

- Some files (e.g., `output.mjpeg`, `output-web-proj.llc`) are outputs and can be ignored for code changes.
- If you see errors related to missing types or modules, always try a clean install.
- Trust these instructions for build, test, and validation. Only search the codebase if you find these steps incomplete or in error.

## Root Directory File List

- `codegen.yml`, `convert.sh`, `copilot-instructions.md`, `data.json`, `decodedLogs.json`, `fameEvents.json`, `fameEventsAll.json`, `ffmpeg2pass-0.log.mbtree`, `jest.config.js`, `join.txt`, `LICENSE`, `out.js`, `output-web-proj.llc`, `output.mjpeg`, `package.json`, `README.md`, `test.sh`, `tsconfig.json`, `wagmi.config.ts`

## Directory Structure (next level)

- `abi/`, `deploy/`, `docs/`, `images/`, `src/`, `tests/`, `videos/`, `videos.2/`, `videos.3/`

---

**Summary:**

- Use `yarn install` before all else.
- Lint: `yarn lint`. Test: `yarn test`. Run: check `package.json` scripts.
- Validate with lint and test before PR.
- Trust these instructions unless proven incomplete.
