import {
	CreateTableCommand,
	DescribeTableCommand,
	DynamoDBClient,
	ResourceNotFoundException,
	UpdateTimeToLiveCommand,
	type CreateTableCommandInput
} from '@aws-sdk/client-dynamodb';
import {
	BatchWriteCommand,
	DynamoDBDocumentClient,
	QueryCommand,
	type QueryCommandInput
} from '@aws-sdk/lib-dynamodb';

/**
 * rbacr keeps everything in one DynamoDB table (SPEC "Runtime and storage"):
 * items are keyed by PK/SK, and the GSI1 index answers the lookups that cut
 * across partitions (everything a grantee holds, the systems that define a
 * role name, a system's vouchers, a person's tokens). infra/tables.yaml
 * creates the same table in AWS.
 */
export interface Table {
	doc: DynamoDBDocumentClient;
	name: string;
}

export type Item = Record<string, unknown>;

export const GSI1 = 'GSI1';

/** The table's shape; kept in step with infra/tables.yaml. */
export function tableDefinition(name: string): CreateTableCommandInput {
	return {
		TableName: name,
		BillingMode: 'PAY_PER_REQUEST',
		AttributeDefinitions: [
			{ AttributeName: 'PK', AttributeType: 'S' },
			{ AttributeName: 'SK', AttributeType: 'S' },
			{ AttributeName: 'GSI1PK', AttributeType: 'S' },
			{ AttributeName: 'GSI1SK', AttributeType: 'S' }
		],
		KeySchema: [
			{ AttributeName: 'PK', KeyType: 'HASH' },
			{ AttributeName: 'SK', KeyType: 'RANGE' }
		],
		GlobalSecondaryIndexes: [
			{
				IndexName: GSI1,
				KeySchema: [
					{ AttributeName: 'GSI1PK', KeyType: 'HASH' },
					{ AttributeName: 'GSI1SK', KeyType: 'RANGE' }
				],
				Projection: { ProjectionType: 'ALL' }
			}
		]
	};
}

/** Expired items (sessions) carry their expiry in `ttl`, in Unix seconds, for DynamoDB to delete. */
export const TTL_ATTRIBUTE = 'ttl';

export function createTable(name: string, endpoint?: string): Table {
	const client = new DynamoDBClient({
		...(endpoint && {
			endpoint,
			region: process.env.AWS_REGION || 'us-east-1',
			// DynamoDB Local accepts any credentials; never use real ones against it.
			credentials: { accessKeyId: 'local', secretAccessKey: 'local' }
		})
	});
	const doc = DynamoDBDocumentClient.from(client, {
		marshallOptions: { removeUndefinedValues: true, convertEmptyValues: false }
	});
	return { doc, name };
}

/** Creates the table when it doesn't exist (DynamoDB Local and tests; AWS uses infra/tables.yaml). */
export async function ensureTable(table: Table): Promise<void> {
	try {
		await table.doc.send(new DescribeTableCommand({ TableName: table.name }));
		return;
	} catch (err) {
		if (!(err instanceof ResourceNotFoundException)) throw err;
	}
	try {
		await table.doc.send(new CreateTableCommand(tableDefinition(table.name)));
	} catch (err) {
		// Another process created it first.
		if ((err as Error).name !== 'ResourceInUseException') throw err;
	}
	await table.doc.send(
		new UpdateTimeToLiveCommand({
			TableName: table.name,
			TimeToLiveSpecification: { AttributeName: TTL_ATTRIBUTE, Enabled: true }
		})
	).catch(() => {});
}

/** Every item a query matches, following pagination. */
export async function queryAll(table: Table, input: Omit<QueryCommandInput, 'TableName'>): Promise<Item[]> {
	const items: Item[] = [];
	let ExclusiveStartKey: Record<string, unknown> | undefined;
	do {
		const page = await table.doc.send(new QueryCommand({ ...input, TableName: table.name, ExclusiveStartKey }));
		items.push(...(page.Items ?? []));
		ExclusiveStartKey = page.LastEvaluatedKey;
	} while (ExclusiveStartKey);
	return items;
}

/** Items in one partition whose sort key starts with `prefix`. */
export function queryPrefix(table: Table, pk: string, prefix: string): Promise<Item[]> {
	return queryAll(table, {
		KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
		ExpressionAttributeValues: { ':pk': pk, ':prefix': prefix }
	});
}

/** Items in one GSI1 partition, optionally newest (highest sort key) first. */
export function queryIndex(table: Table, gsi1pk: string, opts: { newestFirst?: boolean } = {}): Promise<Item[]> {
	return queryAll(table, {
		IndexName: GSI1,
		KeyConditionExpression: 'GSI1PK = :pk',
		ExpressionAttributeValues: { ':pk': gsi1pk },
		ScanIndexForward: !opts.newestFirst
	});
}

/** Deletes items by key, 25 at a time, retrying what DynamoDB leaves unprocessed. */
export async function deleteAll(table: Table, items: Item[]): Promise<void> {
	for (let i = 0; i < items.length; i += 25) {
		let requests: { DeleteRequest: { Key: Item } }[] | undefined = items
			.slice(i, i + 25)
			.map((it) => ({ DeleteRequest: { Key: { PK: it.PK, SK: it.SK } } }));
		for (let attempt = 0; requests?.length; attempt++) {
			if (attempt) await new Promise((r) => setTimeout(r, Math.min(1000, 50 * 2 ** attempt)));
			const res = await table.doc.send(new BatchWriteCommand({ RequestItems: { [table.name]: requests } }));
			requests = res.UnprocessedItems?.[table.name] as typeof requests;
		}
	}
}

/** The cancellation reason codes of a failed TransactWrite, in request order ('None' for items that passed). */
export function cancellationReasons(err: unknown): string[] | null {
	if ((err as Error)?.name !== 'TransactionCanceledException') return null;
	const reasons = (err as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? [];
	return reasons.map((r) => r.Code ?? 'None');
}
