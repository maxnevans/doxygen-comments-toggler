# Doxygen Comments Toggler

<p align="center">
  <img src="images/icon.png" alt="Doxygen Comments Toggler icon" width="160">
</p>

Turn compact documentation comments into readable Doxygen blocks—and back again—without leaving the keyboard.

## What it does

Place the cursor anywhere inside a supported comment and run **Toggle Doxygen Comment** (default shortcut: <kbd>Ctrl</kbd>+<kbd>D</kbd>, <kbd>Ctrl</kbd>+<kbd>D</kbd>).

A one-line Doxygen comment:

```cpp
/** Returns the number of active connections. */
```

becomes a wrapped block:

```cpp
/**
 * Returns the number of active connections.
 */
```

Running the command again collapses the block. Consecutive `//`, `///`, or longer slash-comment lines can also be converted into a Doxygen comment. The extension keeps the cursor near the same text while it rewrites the comment.

The wrapping width is selected in this order:

1. `ColumnLimit` in the first workspace folder's `.clang-format`, when enabled and present.
2. The first value in `editor.rulers`, when enabled and present.
3. `doxygen-comments-toggler.wrapWidth`.
4. A fallback width of 80 columns.

## Usage

- Put the cursor inside a `/** ... */` block or a consecutive group of slash-comment lines.
- Press <kbd>Ctrl</kbd>+<kbd>D</kbd>, <kbd>Ctrl</kbd>+<kbd>D</kbd>.
- Alternatively, open the Command Palette and choose **Toggle Doxygen Comment**.

The shortcut can be changed from **Preferences: Open Keyboard Shortcuts** by searching for `Toggle Doxygen Comment`.

## Settings

| Setting | Default | Purpose |
| --- | ---: | --- |
| `doxygen-comments-toggler.wrapWidth` | `120` | Maximum width used when no enabled `.clang-format` limit or editor ruler is available. |
| `doxygen-comments-toggler.consumeSlashes` | `true` | Removes all leading slashes from each slash-comment line instead of exactly two. |
| `doxygen-comments-toggler.searchClangColumnLimit` | `true` | Reads `ColumnLimit` from `.clang-format` in the first workspace folder. |
| `doxygen-comments-toggler.useRulerAsWidth` | `true` | Uses the first configured `editor.rulers` value as the wrapping width. |

## WSL2-only development workflow

The intended toolchain keeps Node.js and npm inside WSL2. Windows hosts VS Code, but building, testing, debugging, packaging, and publishing all run in the WSL environment; no Windows Node.js installation is required.

### 1. Prepare WSL2

Install a WSL2 distribution and the **WSL** extension for VS Code. Then, in a WSL terminal, install Node.js with a Linux version manager such as `nvm`:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash
nvm install --lts
nvm use --lts
node --version
npm --version
```

For best file-system performance, clone the repository into the Linux file system (for example `~/src/doxygen-comments-toggler`) rather than working under `/mnt/c` or `/mnt/d`.

### 2. Install and build

From the repository in WSL:

```bash
npm ci
npm run compile
```

Open the folder through the WSL remote environment:

```bash
code .
```

Confirm that the lower-left VS Code status area shows a WSL connection. VS Code terminals, tasks, and npm scripts will then use the Node.js installation inside WSL.

### 3. Debug

In the WSL-connected VS Code window, press <kbd>F5</kbd> and choose **Run Extension** if prompted. The configured watch task compiles the TypeScript, and a new Extension Development Host opens with this extension loaded.

Set breakpoints in `src/extension.ts`, open a source file in the development host, place the cursor in a supported comment, and invoke **Toggle Doxygen Comment**.

### 4. Test

Run the full compile, lint, and extension test sequence from WSL:

```bash
npm test
```

The VS Code test runner may download a Linux build of VS Code on its first run. WSLg (available with current WSL2 installations) or an equivalent Linux display setup is needed for Electron-based extension tests.

Useful individual checks are:

```bash
npm run compile
npm run lint
```

### 5. Package and publish

Create a local `.vsix` package from WSL:

```bash
npm run package
```

Before a release, make sure the `development` branch is clean, up to date, and tracks `origin/development`. The version command is the complete local release action: it verifies the branch, runs the tests, updates the package version, creates the version commit and `vX.Y.Z` tag, and pushes the commit and tag:

```bash
git switch development
git pull --ff-only
npm version patch
```

Use `minor` or `major` instead of `patch` when appropriate. The pushed tag automatically starts `.github/workflows/publish.yml` on GitHub Actions. That Ubuntu-based workflow installs Node.js, verifies that the tag and package versions match, confirms that the tagged commit belongs to `development`, runs the tests, builds the VSIX, authenticates with Azure, and publishes the extension to the Visual Studio Marketplace.

Do not run `npm run publish:marketplace` as part of the normal local release process. That script is invoked by the automated workflow after the release tag is pushed. Check the GitHub Actions run and the Marketplace listing to confirm that publication completed successfully.

## Project commands

| Command | Description |
| --- | --- |
| `npm run compile` | Compile TypeScript into `out/`. |
| `npm run watch` | Recompile continuously while developing. |
| `npm run lint` | Check the TypeScript sources with ESLint. |
| `npm test` | Compile, lint, and run the VS Code extension tests. |
| `npm run package` | Build a VSIX package with VSCE. |
| `npm run publish:marketplace` | CI-only Marketplace publishing command invoked by the tagged-release workflow. |

