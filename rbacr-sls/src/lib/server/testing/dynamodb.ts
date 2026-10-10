import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { inject } from 'vitest';
import { createTable, ensureTable, type Item, type Table, type TableKind } from '../dynamo';

/**
 * A fresh, empty table on DynamoDB Local for one test, on the endpoint that
 * src/lib/server/testing/setup.ts provides.
 */
export async function createTestTable(kind: TableKind = 'main'): Promise<Table> {
	const table = createTable(`test-${crypto.randomUUID()}`, inject('dynamodbEndpoint'));
	await ensureTable(table, kind);
	return table;
}

/** Every item in a test table. */
export async function scanAll(table: Table): Promise<Item[]> {
	return (await table.doc.send(new ScanCommand({ TableName: table.name }))).Items ?? [];
}
