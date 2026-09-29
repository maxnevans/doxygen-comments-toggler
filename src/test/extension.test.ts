import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
// import * as myExtension from '../../extension';

import * as extension from '../extension';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Find remove substrings #1', () => {
		{
			const output = extension.diffSubstrings("12 Check", "Check");
			const expected: extension.DiffResult = {
				removed: [
					{
						offset: 0,
						size: 3
					}
				], inserted: []
			};
			assert.deepStrictEqual(output, expected);
		}
		{
			const output = extension.diffSubstrings("/**\n * Check", "/** Check");
			const expected: extension.DiffResult = {
				removed: [
					{
						offset: 1,
						size: 1
					},
					{
						offset: 3,
						size: 2
					}
				], inserted: []
			};
			assert.deepStrictEqual(output, expected);
		}
		{
			const output = extension.diffSubstrings("/**\n * This is\n * content.\n  */", "/** This is content. */");
			const expected: extension.DiffResult = {
				removed:
					[
						{
							/** Removed "*". */
							offset: 1,
							size: 1
						},
						{
							/** Removed "\n " - merged single '*' at pos 2 with the star at pos 5. */
							offset: 3,
							size: 2
						},
						{
							offset: 14,
							size: 3
						},
						{
							offset: 26,
							size: 2
						}
					], inserted: []
			};
			assert.deepStrictEqual(output, expected);
		}
	});
	test('Find remove substrings #2', () => {
		const output = extension.diffSubstrings("/**\n * Check", "/** Check");
		const expected: extension.DiffResult = {
			removed: [
				{
					offset: 1,
					size: 1
				},
				{
					offset: 3,
					size: 2
				}
			], inserted: []
		};
		assert.deepStrictEqual(output, expected);
	});

	test('Find remove substrings #3', () => {
		const output = extension.diffSubstrings("/**\n * This is\n * content.\n  */", "/** This is content. */");
		const expected: extension.DiffResult = {
			removed: [
				{
					/** Removed "*". */
					offset: 1,
					size: 1
				},
				{
					/** Removed "\n " - merged single '*' at pos 2 with the star at pos 5. */
					offset: 3,
					size: 2
				},
				{
					offset: 14,
					size: 3
				},
				{
					offset: 26,
					size: 2
				}
			],
			inserted: []
		};
		assert.deepStrictEqual(output, expected);
	});

	const reverseOutput = (output : extension.DiffResult) : extension.DiffResult => {
		return {
			removed : output.inserted,
			inserted: output.removed
		};
	};

	test('Remap offset from diff #1', () => {
		const output = extension.diffSubstrings("12 Check", "Check");
		const newOffsetRem = extension.remapOffsetFromChanges(output, 0);
		const newOffsetAdd = extension.remapOffsetFromChanges(reverseOutput(output), 0);
		assert.strictEqual(newOffsetRem, 0);
		assert.strictEqual(newOffsetAdd, 3);
	});
	test('Remap offset from diff #2', () => {
		const output = extension.diffSubstrings("12 Check", "Check");
		const newOffsetRem = extension.remapOffsetFromChanges(output, 3);
		const newOffsetAdd = extension.remapOffsetFromChanges(reverseOutput(output), 3);
		assert.strictEqual(newOffsetRem, 0);
		assert.strictEqual(newOffsetAdd, 6);
	});
	test('Remap offset from diff #3', () => {
		const output = extension.diffSubstrings("Check 123", "Check");
		const newOffsetRem = extension.remapOffsetFromChanges(output, 0);
		const newOffsetAdd = extension.remapOffsetFromChanges(reverseOutput(output), 0);
		assert.strictEqual(newOffsetRem, 0);
		assert.strictEqual(newOffsetAdd, 0);
	});
	test('Remap offset from diff #4', () => {
		const output = extension.diffSubstrings("Check 123", "Check");
		const newOffsetRem = extension.remapOffsetFromChanges(output, 3);
		const newOffsetAdd = extension.remapOffsetFromChanges(reverseOutput(output), 3);
		assert.strictEqual(newOffsetRem, 3);
		assert.strictEqual(newOffsetAdd, 3);
	});
	test('Remap offset from diff #5', () => {
		const output = extension.diffSubstrings("Check 123", "Check");
		const newOffsetRem = extension.remapOffsetFromChanges(output, 7);
		const newOffsetAdd = extension.remapOffsetFromChanges(reverseOutput(output), 4);
		assert.strictEqual(newOffsetRem, 5, "Removal.");
		assert.strictEqual(newOffsetAdd, 4, "Addition.");
	});

	test('Remap offset from diff #6', () => {
		const output = extension.diffSubstrings("Check 123", "123 Check");
		const newOffsetRem = extension.remapOffsetFromChanges(output, 7);
		const newOffsetAdd = extension.remapOffsetFromChanges(reverseOutput(output), 7);
		assert.strictEqual(newOffsetRem, 9, "Removal.");
		assert.strictEqual(newOffsetAdd, 3, "Addition.");
	});

	test('Remap offset from diff #7', () => {
		const output = extension.diffSubstrings("// Check", "/** Check */");
		const newOffsetRem = extension.remapOffsetFromChanges(output, 5);
		const newOffsetAdd = extension.remapOffsetFromChanges(reverseOutput(output), 5);
		assert.strictEqual(newOffsetRem, 6, "Removal.");
		assert.strictEqual(newOffsetAdd, 4, "Addition.");
	});

	test('Preserve caret before setup when comment starts later in document', () => {
		const prefix = '{\n\t"editor.fontSize": 16,\n\n';
		const oldText = '    /** Important to setup Editor settings. */';
		const newText = '    /**\n     * Important to setup Editor settings.\n     */';
		const editStartOffset = prefix.length;
		const originalOffset = editStartOffset + oldText.indexOf('setup');

		const newOffset = extension.remapOffsetForEdit(
			oldText,
			newText,
			editStartOffset,
			originalOffset
		);

		assert.strictEqual(
			newOffset,
			editStartOffset + newText.indexOf('setup')
		);
	});

	test('Toggle trailing slash comment without changing preceding code', async () => {
		const original = '    "editor.fontLigatures": true, // \'0xProto\' supports ligatures in terms of compacting symbols closer, e.g. <|||';
		const code = '    "editor.fontLigatures": true, ';
		const blockComment = `${code}/** '0xProto' supports ligatures in terms of compacting symbols closer, e.g. <||| */`;
		const document = await vscode.workspace.openTextDocument({
			content: original,
			language: 'jsonc'
		});
		const editor = await vscode.window.showTextDocument(document);
		const commentStart = original.indexOf('//');
		const cursor = new vscode.Position(0, commentStart);
		editor.selection = new vscode.Selection(cursor, cursor);

		await vscode.commands.executeCommand('doxygen-comments-toggler.toggleComment');

		assert.strictEqual(document.getText(), blockComment);
		assert.strictEqual(editor.selection.active.character, commentStart);

		await vscode.commands.executeCommand('doxygen-comments-toggler.toggleComment');

		assert.strictEqual(document.getText(), original);
		assert.strictEqual(editor.selection.active.character, commentStart);
	});

	test('Reads the nearest clang-format ColumnLimit for C++', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doxygen-toggler-'));
		try {
			const sourceDirectory = path.join(root, 'src');
			fs.mkdirSync(sourceDirectory);
			fs.writeFileSync(path.join(root, '.clang-format'), 'ColumnLimit: 100\n');
			fs.writeFileSync(path.join(sourceDirectory, '.clang-format'), 'ColumnLimit: 88\n');
			const documentPath = path.join(sourceDirectory, 'example.cpp');

			assert.strictEqual(extension.findFormatterColumnLimit(documentPath, root, 'cpp'), 88);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('Treats an explicit unlimited width as opting out of inherited config', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doxygen-toggler-'));
		try {
			const sourceDirectory = path.join(root, 'src');
			fs.mkdirSync(sourceDirectory);
			fs.writeFileSync(path.join(root, '.clang-format'), 'ColumnLimit: 100\n');
			fs.writeFileSync(path.join(sourceDirectory, '.clang-format'), 'ColumnLimit: 0\n');

			assert.strictEqual(extension.findFormatterColumnLimit(path.join(sourceDirectory, 'example.cpp'), root, 'cpp'), null);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('Reads Prettier and ESLint widths without executing config files', () => {
		const prettierRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doxygen-toggler-'));
		const eslintRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doxygen-toggler-'));
		try {
			fs.writeFileSync(path.join(prettierRoot, 'prettier.config.mjs'), 'export default { printWidth: 96 };\n');
			fs.writeFileSync(path.join(eslintRoot, 'eslint.config.mjs'), "export default [{ rules: { 'max-len': ['error', { code: 110 }] } }];\n");

			assert.strictEqual(extension.findFormatterColumnLimit(path.join(prettierRoot, 'app.ts'), prettierRoot, 'typescript'), 96);
			assert.strictEqual(extension.findFormatterColumnLimit(path.join(eslintRoot, 'app.js'), eslintRoot, 'javascript'), 110);
		} finally {
			fs.rmSync(prettierRoot, { recursive: true, force: true });
			fs.rmSync(eslintRoot, { recursive: true, force: true });
		}
	});

	test('Reads language-specific TOML formatter widths', () => {
		const pythonRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doxygen-toggler-'));
		const rustRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doxygen-toggler-'));
		try {
			fs.writeFileSync(path.join(pythonRoot, 'pyproject.toml'), '[tool.black]\nline-length = 99\n');
			fs.writeFileSync(path.join(rustRoot, 'rustfmt.toml'), 'max_width = 101\n');

			assert.strictEqual(extension.findFormatterColumnLimit(path.join(pythonRoot, 'app.py'), pythonRoot, 'python'), 99);
			assert.strictEqual(extension.findFormatterColumnLimit(path.join(rustRoot, 'lib.rs'), rustRoot, 'rust'), 101);
		} finally {
			fs.rmSync(pythonRoot, { recursive: true, force: true });
			fs.rmSync(rustRoot, { recursive: true, force: true });
		}
	});

	test('Applies matching EditorConfig sections', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doxygen-toggler-'));
		try {
			fs.writeFileSync(path.join(root, '.editorconfig'), '[*.{js,ts}]\nmax_line_length = 92\n[*.py]\nmax_line_length = 79\n');

			assert.strictEqual(extension.findFormatterColumnLimit(path.join(root, 'app.ts'), root, 'typescript'), 92);
			assert.strictEqual(extension.findFormatterColumnLimit(path.join(root, 'app.py'), root, 'python'), 79);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
