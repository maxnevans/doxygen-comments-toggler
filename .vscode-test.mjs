import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/**/*.test.js',

	launchArgs: [
		'--disable-gpu',
		'--disable-telemetry',
		'--disable-experiments',
		'--disable-updates',
		'--disable-workspace-trust',
		'--skip-welcome',
		'--skip-release-notes',
		'--use-inmemory-secretstorage',
	],
});