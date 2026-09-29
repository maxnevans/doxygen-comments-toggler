import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(
		vscode.commands.registerCommand('doxygen-comments-toggler.toggleComment', () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				return;
			}

			const doc = editor.document;
			const pos = editor.selection.active;

			const rulers = vscode.workspace.getConfiguration('editor').get<number[]>('rulers');
			const config = vscode.workspace.getConfiguration('doxygen-comments-toggler');
			const searchClangLimit = config.get<boolean>('searchClangColumnLimit');
			const useRulers = config.get<boolean>('useRulerAsWidth');
			const width = searchClangLimit && getClangColumnLimit() || useRulers && rulers?.[0] || config.get<number>('wrapWidth') || 80;

			const block = findCommentBlock(doc, pos.line);

			if (!block) {
				return;
			}

			if (block.type === BlockType.Stars) {
				const text = doc.getText(block.range);

				let newText: string;
				if (isMultilineBlock(text)) {
					newText = toSingleLine(text, block.indent);
				} else {
					newText = toMultiline(text, width, block.indent);
				}

				applyEditWithAst(editor, block.range, text, newText, editor.selection.active);
				return;
			}
			else if (block.type === BlockType.Slashes) {
				const text = doc.getText(block.range);
				const newText = fromSlashComment(text, width, config.get<boolean>('consumeSlashes') ?? false);
				applyEditWithAst(editor, block.range, text, newText, editor.selection.active);
			}
		})
	);
}


function getClangColumnLimit(): number | null {
	const workspace = vscode.workspace.workspaceFolders?.[0];
	if (!workspace) {
		return null;
	}

	const filePath = path.join(workspace.uri.fsPath, '.clang-format');

	if (!fs.existsSync(filePath)) {
		return null;
	}

	const content = fs.readFileSync(filePath, 'utf8');

	const match = content.match(/ColumnLimit:\s*(\d+)/);
	return match ? parseInt(match[1], 10) : null;
}

enum BlockType {
	Slashes,
	Stars
}

function findCommentBlock(doc: vscode.TextDocument, line: number) {
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
		type: blockType
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

function applyEditWithAst(
	editor: vscode.TextEditor,
	range: vscode.Range,
	oldText: string,
	newText: string,
	originalCursor: vscode.Position
) {
	const doc = editor.document;

	const newCursorOffset = remapOffsetForEdit(
		oldText,
		newText,
		doc.offsetAt(range.start),
		doc.offsetAt(originalCursor)
	);

	editor.edit(edit => {
		edit.replace(range, newText);
	}).then(() => {
		const finalPos = editor.document.positionAt(newCursorOffset);
		editor.selection = new vscode.Selection(finalPos, finalPos);
	});
}
