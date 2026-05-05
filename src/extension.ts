import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(
		vscode.commands.registerCommand('cpp-comments-toggler.toggleComment', () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) return;

			const doc = editor.document;
			const pos = editor.selection.active;

			const rulers = vscode.workspace.getConfiguration('editor').get<number[]>('rulers');
			const config = vscode.workspace.getConfiguration('cpp-comments-toggler');
			const width = getClangColumnLimit() || rulers?.[0] || config.get<number>('wrapWidth') || 80;

			const block = findCommentBlock(doc, pos.line);

			if (block) {
				const text = doc.getText(block.range);

				let newText: string;
				if (isMultilineBlock(text)) {
					newText = toSingleLine(text, block.indent);
				} else {
					newText = toMultiline(text, width, block.indent);
				}

				applyEditWithAST(editor, block.range, text, newText, editor.selection.active);
				return;
			}

			// fallback: check for // comment
			const line = doc.lineAt(pos.line);
			if (line.text.trim().startsWith('//')) {
				const newText = fromSlashComment(line.text, width);
				applyEditWithAST(editor, line.range, line.text, newText, editor.selection.active);
			}
		})
	);
}


function getClangColumnLimit(): number | null {
	const workspace = vscode.workspace.workspaceFolders?.[0];
	if (!workspace) return null;

	const filePath = path.join(workspace.uri.fsPath, '.clang-format');

	if (!fs.existsSync(filePath)) return null;

	const content = fs.readFileSync(filePath, 'utf8');

	const match = content.match(/ColumnLimit:\s*(\d+)/);
	return match ? parseInt(match[1], 10) : null;
}

function findCommentBlock(doc: vscode.TextDocument, line: number) {
	let start = line;
	let end = line;

	// find /**
	while (start >= 0) {
		const text = doc.lineAt(start).text;
		if (text.includes('/**')) break;
		if (text.includes('*/')) return null;
		start--;
	}

	if (start < 0) return null;

	// find */
	while (end < doc.lineCount) {
		const text = doc.lineAt(end).text;
		if (text.includes('*/')) break;
		end++;
	}

	if (end >= doc.lineCount) return null;

	const startLine = doc.lineAt(start).text;
	return {
		range: new vscode.Range(start, 0, end, doc.lineAt(end).text.length),
		indent: getIndent(startLine)
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

function fromSlashComment(line: string, width: number): string {
	const indent = getIndent(line);

	const content = line
		.trim()
		.replace(/^\/\/\s?/, '');

	const wrapped = (() => {
		const singleLineWrapped = wrapSmart(content, width - indent.length - "/**  */".length);
		if (singleLineWrapped.length <= 1) {
			return singleLineWrapped;
		}
		return wrapSmart(content, width - indent.length - " * ".length);
	})();

	if (wrapped.length <= 1) return `${indent}/** ${wrapped[0]} */`;

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
			if (current) lines.push(current);

			current = word;
		} else {
			current = next;
		}

		// prefer breaking after sentence endings
		if (/[.!?]$/.test(word) && current.length > maxWidth * 0.6) {
			lines.push(current);
			current = '';
		}
	}

	if (current) lines.push(current);

	return lines;
}

type Token = {
    text: string;
    start: number;
    end: number;
};

function tokenize(content: string): Token[] {
    const tokens: Token[] = [];
    const regex = /\w+|[^\s\w]/g;

    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) {
        tokens.push({
            text: match[0],
            start: match.index,
            end: match.index + match[0].length
        });
    }

    return tokens;
}

function findTokenAtOffset(tokens: Token[], offset: number) {
    for (let i = 0; i < tokens.length; i++) {
        if (offset >= tokens[i].start && offset <= tokens[i].end) {
            return {
                tokenIndex: i,
                innerOffset: offset - tokens[i].start
            };
        }
    }

    return {
        tokenIndex: tokens.length - 1,
        innerOffset: 0
    };
}

function restoreOffsetFromToken(
    tokens: Token[],
    mapping: { tokenIndex: number; innerOffset: number }
) {
    if (tokens.length === 0) return 0;

    const token = tokens[Math.min(mapping.tokenIndex, tokens.length - 1)];

    return token.start + Math.min(mapping.innerOffset, token.text.length);
}

function extractCommentContent(text: string): string {
    return text
        .replace(/\/\*\*?/g, '')
        .replace(/\*\//g, '')
        .replace(/^\s*\*\s?/gm, '')
        .replace(/^\/\/\s?/gm, '')
        .trim();
}

function findContentStart(text: string): number {
    const lines = text.split('\n');

    let offset = 0;

    for (const line of lines) {
        const starMatch = line.match(/^\s*\*\s?/);
        if (starMatch) {
            return offset + starMatch[0].length;
        }

        if (line.includes('/**')) {
            offset += line.length + 1;
            continue;
        }

        return offset;
    }

    return 0;
}

function applyEditWithAST(
    editor: vscode.TextEditor,
    range: vscode.Range,
    oldText: string,
    newText: string,
    originalCursor: vscode.Position
) {
    const doc = editor.document;

    const startOffset = doc.offsetAt(range.start);
    const cursorOffset = doc.offsetAt(originalCursor);

    // 1. Extract content
    const oldContent = extractCommentContent(oldText);

    const contentStartOld = findContentStart(oldText);
    const relativeContentOffset = Math.max(0, cursorOffset - startOffset - contentStartOld);

    // 2. Tokenize
    const oldTokens = tokenize(oldContent);
	console.log(oldTokens);

    const tokenMapping = findTokenAtOffset(oldTokens, relativeContentOffset);

    // 3. Apply edit
    editor.edit(edit => {
        edit.replace(range, newText);
    }).then(() => {

        const newContent = extractCommentContent(newText);
        const newTokens = tokenize(newContent);

        const newContentOffset = restoreOffsetFromToken(newTokens, tokenMapping);

        const contentStartNew = findContentStart(newText);

        const finalOffset =
            editor.document.offsetAt(range.start) +
            contentStartNew +
            newContentOffset;

        const finalPos = editor.document.positionAt(finalOffset);

        editor.selection = new vscode.Selection(finalPos, finalPos);
    });
}