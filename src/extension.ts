import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(
		vscode.commands.registerCommand('doxygen-comments-toggler.toggleComment', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				return;
			}

			const doc = editor.document;
			const pos = editor.selection.active;

			const rulers = vscode.workspace.getConfiguration('editor').get<number[]>('rulers');
			const config = vscode.workspace.getConfiguration('doxygen-comments-toggler');
			const searchFormatterLimit = config.get<boolean>('searchFormatterConfig') ?? true;
			const useRulers = config.get<boolean>('useRulerAsWidth');
			const workspace = vscode.workspace.getWorkspaceFolder(doc.uri);
			const formatterWidth = searchFormatterLimit && workspace && doc.uri.scheme === 'file'
				? findFormatterColumnLimit(doc.uri.fsPath, workspace.uri.fsPath, doc.languageId)
				: null;
			const width = formatterWidth || useRulers && rulers?.[0] || config.get<number>('wrapWidth') || 80;

			const block = findCommentBlock(doc, pos);

			if (!block) {
				return;
			}

			if (block.type === BlockType.Stars) {
				const text = doc.getText(block.range);

				let newText: string;
				if (block.inline) {
					newText = toInlineSlashComment(text);
				} else if (isMultilineBlock(text)) {
					newText = toSingleLine(text, block.indent);
				} else {
					newText = toMultiline(text, width, block.indent);
				}

				await applyEditWithAst(editor, block.range, text, newText, editor.selection.active);
				return;
			}
			else if (block.type === BlockType.Slashes) {
				const text = doc.getText(block.range);
				const consumeSlashes = config.get<boolean>('consumeSlashes') ?? false;
				const newText = block.inline
					? fromInlineSlashComment(text, consumeSlashes)
					: fromSlashComment(text, width, consumeSlashes);
				await applyEditWithAst(editor, block.range, text, newText, editor.selection.active);
			}
		})
	);
}

type FormatterConfig = {
	name: string;
	read: (content: string, configPath: string, documentPath: string) => number | null;
};

const clangLanguages = new Set(['c', 'cpp', 'cuda-cpp', 'objective-c', 'objective-cpp', 'java', 'javascript', 'typescript', 'csharp', 'proto']);
const prettierLanguages = new Set(['javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'json', 'jsonc', 'css', 'scss', 'less', 'html', 'vue', 'svelte', 'yaml', 'markdown', 'mdx', 'graphql']);
const eslintLanguages = new Set(['javascript', 'javascriptreact', 'typescript', 'typescriptreact']);

const readPattern = (pattern: RegExp) => (content: string): number | null => {
	const match = content.match(pattern);
	return toWidth(match?.[1]);
};

const readClangWidth = (content: string): number | null => {
	const match = content.match(/^\s*ColumnLimit\s*:\s*(\d+)/m);
	return match?.[1] === '0' ? 0 : toWidth(match?.[1]);
};
const readPrettierWidth = readPattern(/["']?printWidth["']?\s*[:=]\s*(\d+)/);
const readBiomeWidth = readPattern(/["']?lineWidth["']?\s*:\s*(\d+)/);
const readDenoWidth = readPattern(/["']?lineWidth["']?\s*:\s*(\d+)/);
const readRustWidth = readPattern(/^\s*max_width\s*=\s*(\d+)/m);
const readRuffWidth = readPattern(/^\s*line-length\s*=\s*(\d+)/m);
const readFlake8Width = readPattern(/^\s*max-line-length\s*=\s*(\d+)/m);

function toWidth(value: string | number | undefined): number | null {
	const width = typeof value === 'number' ? value : Number.parseInt(value ?? '', 10);
	return Number.isInteger(width) && width > 0 ? width : null;
}

function readEslintWidth(content: string): number | null {
	const ruleIndex = content.search(/["']?max-len["']?\s*:/);
	if (ruleIndex < 0) {
		return null;
	}

	const rule = content.slice(ruleIndex, ruleIndex + 600);
	const code = rule.match(/["']?code["']?\s*:\s*(\d+)/);
	if (code) {
		return toWidth(code[1]);
	}

	const arrayWidth = rule.match(/:\s*\[\s*(?:["'](?:error|warn)["']|[12])\s*,\s*(\d+)/);
	return toWidth(arrayWidth?.[1]);
}

function readPackageWidth(content: string): number | null {
	try {
		const packageJson = JSON.parse(content) as {
			prettier?: { printWidth?: number };
			eslintConfig?: { rules?: Record<string, unknown> };
		};
		const prettierWidth = toWidth(packageJson.prettier?.printWidth);
		if (prettierWidth) {
			return prettierWidth;
		}

		const maxLen = packageJson.eslintConfig?.rules?.['max-len'];
		if (Array.isArray(maxLen)) {
			const options = maxLen[1];
			if (typeof options === 'number') {
				return toWidth(options);
			}
			if (options && typeof options === 'object' && 'code' in options) {
				return toWidth((options as { code?: number }).code);
			}
		}
	} catch {
		return null;
	}
	return null;
}

function readPyprojectWidth(content: string): number | null {
	const sections = ['tool.black', 'tool.ruff', 'tool.ruff.format'];
	for (const section of sections) {
		const escaped = section.replaceAll('.', '\\.');
		const match = content.match(new RegExp(`^\\s*\\[${escaped}\\]\\s*$([\\s\\S]*?)(?=^\\s*\\[|(?![\\s\\S]))`, 'm'));
		const width = match && readRuffWidth(match[1]);
		if (width) {
			return width;
		}
	}
	return null;
}

function readRubocopWidth(content: string): number | null {
	const section = content.match(/^Layout\/LineLength\s*:\s*$([\s\S]*?)(?=^[^\s#][^:]*:\s*$|(?![\s\S]))/m);
	return section ? readPattern(/^\s*Max\s*:\s*(\d+)/m)(section[1]) : null;
}

function readDartWidth(content: string): number | null {
	const section = content.match(/^formatter\s*:\s*$([\s\S]*?)(?=^[^\s#][^:]*:\s*$|(?![\s\S]))/m);
	return section ? readPattern(/^\s*page_width\s*:\s*(\d+)/m)(section[1]) : null;
}

function expandBraces(pattern: string): string[] {
	const match = pattern.match(/\{([^{}]+)\}/);
	if (!match || match.index === undefined) {
		return [pattern];
	}
	return match[1].split(',').flatMap(part => expandBraces(
		pattern.slice(0, match.index) + part + pattern.slice(match.index! + match[0].length)
	));
}

function matchesEditorConfigPattern(pattern: string, relativePath: string): boolean {
	const target = pattern.includes('/') ? relativePath.replaceAll('\\', '/') : path.basename(relativePath);
	return expandBraces(pattern).some(expanded => {
		let expression = '';
		for (let i = 0; i < expanded.length; i++) {
			const char = expanded[i];
			if (char === '*' && expanded[i + 1] === '*') {
				expression += '.*';
				i++;
			} else if (char === '*') {
				expression += '[^/]*';
			} else if (char === '?') {
				expression += '[^/]';
			} else {
				expression += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
			}
		}
		return new RegExp(`^${expression}$`).test(target);
	});
}

function readEditorConfigWidth(content: string, configPath: string, documentPath: string): number | null {
	const relativePath = path.relative(path.dirname(configPath), documentPath).replaceAll('\\', '/');
	let applies = true;
	let width: number | null = null;
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#') || line.startsWith(';')) {
			continue;
		}
		const section = line.match(/^\[(.+)]$/);
		if (section) {
			applies = matchesEditorConfigPattern(section[1], relativePath);
			continue;
		}
		if (applies) {
			const setting = line.match(/^max_line_length\s*=\s*(\d+|off)\s*$/i);
			if (setting) {
				width = setting[1].toLowerCase() === 'off' ? 0 : toWidth(setting[1]);
			}
		}
	}
	return width;
}

function config(name: string, read: FormatterConfig['read']): FormatterConfig {
	return { name, read };
}

function formatterConfigs(languageId: string): FormatterConfig[] {
	const configs: FormatterConfig[] = [];
	if (clangLanguages.has(languageId)) {
		configs.push(config('.clang-format', readClangWidth), config('_clang-format', readClangWidth));
	}
	if (languageId === 'python') {
		configs.push(
			config('pyproject.toml', readPyprojectWidth),
			config('ruff.toml', readRuffWidth),
			config('.ruff.toml', readRuffWidth),
			config('setup.cfg', readFlake8Width),
			config('.flake8', readFlake8Width)
		);
	}
	if (languageId === 'rust') {
		configs.push(config('rustfmt.toml', readRustWidth), config('.rustfmt.toml', readRustWidth));
	}
	if (languageId === 'ruby') {
		configs.push(config('.rubocop.yml', readRubocopWidth), config('.rubocop.yaml', readRubocopWidth));
	}
	if (languageId === 'dart') {
		configs.push(config('analysis_options.yaml', readDartWidth), config('analysis_options.yml', readDartWidth));
	}
	if (prettierLanguages.has(languageId)) {
		configs.push(
			config('biome.json', readBiomeWidth), config('biome.jsonc', readBiomeWidth),
			config('deno.json', readDenoWidth), config('deno.jsonc', readDenoWidth),
			...['.prettierrc', '.prettierrc.json', '.prettierrc.yaml', '.prettierrc.yml', '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.mjs', 'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs']
				.map(name => config(name, readPrettierWidth))
		);
	}
	if (eslintLanguages.has(languageId)) {
		configs.push(
			...['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', '.eslintrc', '.eslintrc.json', '.eslintrc.yaml', '.eslintrc.yml', '.eslintrc.js', '.eslintrc.cjs']
				.map(name => config(name, readEslintWidth)),
			config('package.json', readPackageWidth)
		);
	} else if (prettierLanguages.has(languageId)) {
		configs.push(config('package.json', readPackageWidth));
	}
	configs.push(config('.editorconfig', readEditorConfigWidth));
	return configs;
}

export function findFormatterColumnLimit(documentPath: string, workspaceRoot: string, languageId: string): number | null {
	const root = path.resolve(workspaceRoot);
	let directory = path.resolve(path.dirname(documentPath));
	const relativeToRoot = path.relative(root, directory);
	if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
		directory = root;
	}

	const candidates = formatterConfigs(languageId);
	while (true) {
		for (const candidate of candidates) {
			const configPath = path.join(directory, candidate.name);
			try {
				if (!fs.statSync(configPath).isFile()) {
					continue;
				}
				const width = candidate.read(fs.readFileSync(configPath, 'utf8'), configPath, documentPath);
				if (width === 0) {
					return null;
				}
				if (width) {
					return width;
				}
			} catch {
				// Missing, unreadable, or malformed configs simply fall through to the next source.
			}
		}

		if (path.relative(root, directory) === '') {
			break;
		}
		const parent = path.dirname(directory);
		if (parent === directory) {
			break;
		}
		directory = parent;
	}
	return null;
}

enum BlockType {
	Slashes,
	Stars
}

function findInlineComment(text: string): { start: number; type: BlockType } | null {
	let quote: string | null = null;
	let escaped = false;

	for (let i = 0; i < text.length - 1; i++) {
		const char = text[i];

		if (quote !== null) {
			if (escaped) {
				escaped = false;
			} else if (char === '\\') {
				escaped = true;
			} else if (char === quote) {
				quote = null;
			}
			continue;
		}

		if (char === '"' || char === "'" || char === '`') {
			quote = char;
			continue;
		}

		if (text.startsWith('//', i)) {
			return { start: i, type: BlockType.Slashes };
		}
		if (text.startsWith('/**', i)) {
			return { start: i, type: BlockType.Stars };
		}
	}

	return null;
}

function findCommentBlock(doc: vscode.TextDocument, position: vscode.Position) {
	const line = position.line;
	const currentLine = doc.lineAt(line).text;
	const inlineComment = findInlineComment(currentLine);

	if (inlineComment && currentLine.slice(0, inlineComment.start).trim().length > 0) {
		if (position.character < inlineComment.start) {
			return null;
		}

		const end = inlineComment.type === BlockType.Stars
			? currentLine.indexOf('*/', inlineComment.start + 3) + 2
			: currentLine.length;

		if (end < 2) {
			return null;
		}

		return {
			range: new vscode.Range(line, inlineComment.start, line, end),
			indent: '',
			type: inlineComment.type,
			inline: true
		};
	}

	let start = line;
	let end = line;
	let blockType: BlockType | null = null;

	// find /**
	while (start >= 0) {
		const text = doc.lineAt(start).text;

		if (text.trimStart().startsWith('//')) {
			if (blockType === null) {
				blockType = BlockType.Slashes;
			}
			else if (blockType === BlockType.Stars)
			{
				blockType = null;
				break;
			}
		}
		else if (blockType === BlockType.Slashes) {
			break;
		}
		if ((blockType === null || blockType === BlockType.Stars) && text.includes('/**')) {
			blockType = BlockType.Stars;
			break;
		}
		if (blockType === null && text.includes('*/')) {
			blockType = BlockType.Stars;
		}
		start--;
	}
	if (blockType === BlockType.Slashes) {
		start++;
	}

	if (blockType === null || start < 0) {
		return null;
	}

	// find */
	while (end < doc.lineCount) {
		const text = doc.lineAt(end).text;

		if (blockType === BlockType.Slashes) {
			if (!text.trimStart().startsWith('//')) {
				break;
			}
		}
		else if (blockType === BlockType.Stars) {
			if (text.includes('*/')) {
				break;
			}
		}

		end++;
	}
	if (blockType === BlockType.Slashes) {
		end--;
	}

	if (end >= doc.lineCount) {
		return null;
	}

	const startLine = doc.lineAt(start).text;
	return {
		range: new vscode.Range(start, 0, end, doc.lineAt(end).text.length),
		indent: getIndent(startLine),
		type: blockType,
		inline: false
	};
}

function getIndent(line: string): string {
	return line.match(/^\s*/)?.[0] ?? '';
}

function isMultilineBlock(text: string): boolean {
	return text.includes('\n');
}

function toSingleLine(text: string, indent: string): string {
	const content = text
		.split('\n')
		.map(l => l.trim())
		.filter(l => l && l !== '/**' && l !== '*/')
		.map(l => l.replace(/^\*\s?/, ''))
		.join(' ')
		.replace(/\s+/g, ' ')
		.trim();

	return `${indent}/** ${content} */`;
}

function toMultiline(text: string, width: number, indent: string): string {
	const content = text
		.replace('/**', '')
		.replace('*/', '')
		.trim();

	const wrapped = wrapSmart(content, width - indent.length - 3);

	let result = `${indent}/**\n`;
	for (const line of wrapped) {
		result += `${indent} * ${line}\n`;
	}
	result += `${indent} */`;

	return result;
}

function fromSlashComment(line: string, width: number, consumeAllSlashesAtLineStart: boolean): string {
	const indent = getIndent(line);
	const slashesAmountToConsume = consumeAllSlashesAtLineStart ? "{2,}" : "{2}";
	const content = line.replace(new RegExp(`^(\\s*)\/${slashesAmountToConsume}\\s?`, "gm"), "$1").trim();

	const wrapped = (() => {
		const singleLineWrapped = wrapSmart(content, width - indent.length - "/**  */".length);
		if (singleLineWrapped.length <= 1) {
			return singleLineWrapped;
		}
		return wrapSmart(content, width - indent.length - " * ".length);
	})();

	if (wrapped.length <= 1) {
		return `${indent}/** ${wrapped[0]} */`;
	}

	let result = `${indent}/**\n`;

	for (const l of wrapped) {
		result += `${indent} * ${l}\n`;
	}

	result += `${indent} */`;

	return result;
}

function fromInlineSlashComment(text: string, consumeAllSlashesAtLineStart: boolean): string {
	const slashesAmountToConsume = consumeAllSlashesAtLineStart ? '{2,}' : '{2}';
	const content = text.replace(new RegExp(`^\/${slashesAmountToConsume}\\s?`), '').trim();
	return content ? `/** ${content} */` : '/** */';
}

function toInlineSlashComment(text: string): string {
	const content = text.replace(/^\/\*\*\s?/, '').replace(/\s?\*\/$/, '').trim();
	return content ? `// ${content}` : '//';
}

function wrapSmart(text: string, maxWidth: number): string[] {
	const words = text.split(/\s+/);
	const lines: string[] = [];

	let current = '';

	for (const word of words) {
		const next = current ? current + ' ' + word : word;

		if (next.length > maxWidth) {
			if (current) {
				lines.push(current);
			}

			current = word;
		} else {
			current = next;
		}

		/** prefer breaking after sentence endings */
		if (/[.!?]$/.test(word) && current.length > maxWidth * 0.6) {
			lines.push(current);
			current = '';
		}
	}

	if (current) {
		lines.push(current);
	}

	return lines;
}

export type Change = {
	offset: number;
	size: number;
};

export type DiffResult = {
	removed: Change[];
	inserted: Change[];
};

export function diffSubstrings(original: string, result: string): DiffResult {
	const m = original.length;
	const n = result.length;

	/** LCS table */
	const dp: number[][] = Array.from({ length: m + 1 }, () =>
		Array(n + 1).fill(0)
	);

	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			if (original[i - 1] === result[j - 1]) {
				dp[i][j] = dp[i - 1][j - 1] + 1;
			} else {
				dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
			}
		}
	}

	const removed: Change[] = [];
	const inserted: Change[] = [];

	let i = m;
	let j = n;

	let remStart = -1;
	let remEnd = -1;

	let insStart = -1;
	let insEnd = -1;

	const flushRemoval = () => {
		if (remStart !== -1) {
			removed.push({
				offset: remStart,
				size: remEnd - remStart + 1,
			});

			remStart = -1;
			remEnd = -1;
		}
	};

	const flushInsert = () => {
		if (insStart !== -1) {
			inserted.push({
				offset: insStart,
				size: insEnd - insStart + 1,
			});

			insStart = -1;
			insEnd = -1;
		}
	};

	while (i > 0 || j > 0) {
		if (
			i > 0 &&
			j > 0 &&
			original[i - 1] === result[j - 1]
		) {
			flushRemoval();
			flushInsert();

			i--;
			j--;
		} else if (
			j > 0 &&
			(i === 0 || dp[i][j - 1] >= dp[i - 1][j])
		) {
			/** insertion into result */
			flushRemoval();

			if (insStart === -1) {
				insStart = j - 1;
				insEnd = j - 1;
			} else {
				insStart = j - 1;
			}

			j--;
		} else {
			/** removal from original */
			flushInsert();

			if (remStart === -1) {
				remStart = i - 1;
				remEnd = i - 1;
			} else {
				remStart = i - 1;
			}

			i--;
		}
	}

	flushRemoval();
	flushInsert();

	removed.reverse();
	inserted.reverse();

	return { removed, inserted };
}

export function remapOffsetFromChanges(diff: DiffResult, offset: number): number {
	let newOffset = offset;
	for (let i = 0; i < diff.removed.length; i++) {
		const removal = diff.removed[i];
		if (removal.offset < offset) {
			newOffset -= Math.min(removal.size, offset - removal.offset);
		}
		else {
			break;
		}
	}
	for (let j = 0; j < diff.inserted.length; j++) {
		const insertion = diff.inserted[j];
		if (insertion.offset <= newOffset) {
			newOffset += insertion.size;
		}
		else {
			break;
		}
	}
	return newOffset;
}

export function remapOffsetForEdit(
	oldText: string,
	newText: string,
	editStartOffset: number,
	originalOffset: number
): number {
	const relativeOffset = Math.max(0, originalOffset - editStartOffset);
	const changes = diffSubstrings(oldText, newText);
	return editStartOffset + remapOffsetFromChanges(changes, relativeOffset);
}

async function applyEditWithAst(
	editor: vscode.TextEditor,
	range: vscode.Range,
	oldText: string,
	newText: string,
	originalCursor: vscode.Position
): Promise<void> {
	const doc = editor.document;

	const newCursorOffset = remapOffsetForEdit(
		oldText,
		newText,
		doc.offsetAt(range.start),
		doc.offsetAt(originalCursor)
	);

	const applied = await editor.edit(edit => {
		edit.replace(range, newText);
	});
	if (!applied) {
		return;
	}

	const finalPos = editor.document.positionAt(newCursorOffset);
	editor.selection = new vscode.Selection(finalPos, finalPos);
}
