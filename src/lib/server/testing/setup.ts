import { execFileSync } from 'node:child_process';
import type { TestProject } from 'vitest/node';

/**
 * Vitest global setup: the unit tests need DynamoDB Local. Uses
 * RBACR_TEST_DYNAMODB_ENDPOINT when set; otherwise starts a throwaway
 * in-memory amazon/dynamodb-local container (Docker) on a free port and
 * removes it afterwards.
 */
const IMAGE = 'amazon/dynamodb-local:3.1.0';

async function waitFor(endpoint: string): Promise<void> {
	for (let i = 0; i < 100; i++) {
		// DynamoDB Local answers unsigned requests with 400, which means it's up.
		if (await fetch(endpoint).then(() => true, () => false)) return;
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error(`DynamoDB Local did not start at ${endpoint}`);
}

export default async function setup(project: TestProject): Promise<() => void> {
	let endpoint = process.env.RBACR_TEST_DYNAMODB_ENDPOINT;
	let container: string | undefined;
	if (!endpoint) {
		container = execFileSync(
			'docker',
			['run', '-d', '--rm', '-p', '127.0.0.1::8000', IMAGE, '-jar', 'DynamoDBLocal.jar', '-inMemory'],
			{ encoding: 'utf8' }
		).trim();
		const port = execFileSync('docker', ['port', container, '8000/tcp'], { encoding: 'utf8' }).trim().split(':').pop();
		endpoint = `http://127.0.0.1:${port}`;
	}
	await waitFor(endpoint);
	process.env.RBACR_TEST_DYNAMODB_ENDPOINT = endpoint;
	project.provide('dynamodbEndpoint', endpoint);
	return () => {
		if (container) execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
	};
}

declare module 'vitest' {
	export interface ProvidedContext {
		dynamodbEndpoint: string;
	}
}
