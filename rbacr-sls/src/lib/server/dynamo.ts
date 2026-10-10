import {
	CreateTableCommand,
	DescribeTableCommand,
	DynamoDBClient,
	ResourceNotFoundException,
	UpdateTimeToLiveCommand,
	type CreateTableCommandInput
} from '@aws-sdk/client-dynamodb';
import {
	DynamoDBDocumentClient,
	QueryCommand,
	type QueryCommandInput
} from '@aws-sdk/lib-dynamodb';

/**
 * rbacr keeps everything in one DynamoDB table (SPEC "Runtime and storage"):
 * items are keyed by PK/SK, and the GSI1 index answers the lookups that cut
 * across partitions (everything a grantee holds, the systems that define a
 * role name, a system's vouchers, a person's tokens). infra/tables.yaml
 * creates the same table in AWS. Nothing is ever deleted from it (SPEC L1),
 * so it has no TTL. Sign-in sessions live in a table of their own, with the
 * same keys but no index, which DynamoDB purges by TTL (SPEC S3).
 */
export interface Table {
	doc: DynamoDBDocumentClient;
	name: string;
}

export type Item = Record<string, unknown>;

export const GSI1 = 'GSI1';

/** Session items carry when DynamoDB may purge them here, in Unix seconds (SPEC S3). */
export const TTL_ATTRIBUTE = 'ttl';

/** What kind of table: the main one (with GSI1, no TTL) or the sessions one (TTL, no index). */
export type TableKind = 'main' | 'sessions';

/** A table's shape; kept in step with infra/tables.yaml. */
export function tableDefinition(name: string, kind: TableKind = 'main'): CreateTableCommandInput {
	const keys: CreateTableCommandInput = {
		TableName: name,
		BillingMode: 'PAY_PER_REQUEST',
		AttributeDefinitions: [
			{ AttributeName: 'PK', AttributeType: 'S' },
			{ AttributeName: 'SK', AttributeType: 'S' }
		],
		KeySchema: [
			{ AttributeName: 'PK', KeyType: 'HASH' },
			{ AttributeName: 'SK', KeyType: 'RANGE' }
		]
	};
	if (kind === 'sessions') return keys;
	return {
		...keys,
		AttributeDefinitions: [
			...keys.AttributeDefinitions!,
			{ AttributeName: 'GSI1PK', AttributeType: 'S' },
			{ AttributeName: 'GSI1SK', AttributeType: 'S' }
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
export async function ensureTable(table: Table, kind: TableKind = 'main'): Promise<void> {
	try {
		await table.doc.send(new DescribeTableCommand({ TableName: table.name }));
		return;
	} catch (err) {
		if (!(err instanceof ResourceNotFoundException)) throw err;
	}
	try {
		await table.doc.send(new CreateTableCommand(tableDefinition(table.name, kind)));
	} catch (err) {
		// Another process created it first.
		if ((err as Error).name !== 'ResourceInUseException') throw err;
	}
	if (kind === 'sessions') {
		await table.doc
			.send(
				new UpdateTimeToLiveCommand({
					TableName: table.name,
					TimeToLiveSpecification: { AttributeName: TTL_ATTRIBUTE, Enabled: true }
				})
			)
			.catch(() => {});
	}
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

/** The cancellation reason codes of a failed TransactWrite, in request order ('None' for items that passed). */
export function cancellationReasons(err: unknown): string[] | null {
	if ((err as Error)?.name !== 'TransactionCanceledException') return null;
	const reasons = (err as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? [];
	return reasons.map((r) => r.Code ?? 'None');
}
