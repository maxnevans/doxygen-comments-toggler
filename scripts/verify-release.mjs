import { execFileSync } from 'node:child_process';

const expectedBranch = 'development';
const expectedUpstream = `origin/${expectedBranch}`;

function git(...args) {
	return execFileSync('git', args, {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();
}

let branch;
let upstream;

try {
	branch = git('branch', '--show-current');
	upstream = git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}');
} catch (error) {
	const details = error.stderr?.trim() || error.message;
	console.error(`Unable to inspect the Git release branch: ${details}`);
	process.exit(1);
}

if (branch !== expectedBranch) {
	console.error(`Releases must be created from '${expectedBranch}', not '${branch || 'detached HEAD'}'.`);
	process.exit(1);
}

if (upstream !== expectedUpstream) {
	console.error(`'${expectedBranch}' must track '${expectedUpstream}', not '${upstream}'.`);
	process.exit(1);
}

console.log(`Release branch verified: ${branch} -> ${upstream}`);
