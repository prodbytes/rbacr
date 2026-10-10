<!--
	The form that creates a voucher (SPEC V1, V2), for a system or global:
	the roles it grants, its code (suggested), its validity (this quarter by
	default) and its terms. The page does the request through `create`.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { formValues, utcInputValue, utcIso } from '#lib/vpi.js';
	import { quarterOf, suggestVoucherCode } from '#lib/vouchers.js';

	export interface VoucherBody {
		/** A system voucher's roles. */
		roles?: string[];
		/** A global voucher's system roles (SPEC V1). */
		grants?: { systemId: string; role: string }[];
		code: string;
		discountPercent: string;
		startsAt: string | null;
		endsAt: string | null;
		maxUses: string | null;
	}

	let {
		roles = [],
		systems,
		rolesHint = '',
		empty = 'No roles yet.',
		create
	}: {
		/** A system voucher's roles to pick from. */
		roles?: string[];
		/** For a global voucher: each system with its roles, to pick system roles from (SPEC V1). */
		systems?: { id: string; name: string; roles: string[] }[];
		/** Says where the roles apply, under the roles heading. */
		rolesHint?: string;
		/** Shown when there are no roles to pick. */
		empty?: string;
		/** Sends the voucher; resolves to the created one, or undefined if it failed (the page shows why). */
		create: (body: VoucherBody) => Promise<{ code: string } | undefined>;
	} = $props();

	// A new voucher defaults to this quarter: its code and its validity (V2).
	const quarter = quarterOf(new Date());
	// A system's role is `role`; a global voucher's, `systemId#role` (`#` is in neither).
	let picked = $state<string[]>([]);
	const pair = (key: string) => {
		const [systemId, role] = key.split('#');
		return { systemId, role };
	};
	let systemNames = $derived(new Map((systems ?? []).map((s) => [s.id, s.name])));
	let pickedLabels = $derived(
		picked.map((k) => {
			if (!systems) return k;
			const { systemId, role } = pair(k);
			return `${systemNames.get(systemId) ?? systemId} / ${role}`;
		})
	);
	let code = $state('');
	let discount = $state(100);
	let created = $state('');
	// Made up in the browser, so server rendering doesn't pick a different one.
	onMount(() => (code = suggestVoucherCode()));

	async function submit(e: SubmitEvent) {
		const v = formValues(e);
		created = '';
		const res = await create({
			...(systems ? { grants: picked.map(pair) } : { roles: picked }),
			code,
			discountPercent: v.discountPercent,
			startsAt: utcIso(v.startsAt),
			endsAt: utcIso(v.endsAt),
			maxUses: v.maxUses || null
		});
		if (res) {
			created = res.code;
			code = suggestVoucherCode();
			picked = [];
		}
	}
</script>

<form class="voucher-form" onsubmit={submit}>
	<fieldset class="group">
		<legend>Roles it grants</legend>
		{#if rolesHint}<p class="hint">{rolesHint}</p>{/if}
		{#if systems}
			{#each systems.filter((s) => s.roles.length) as system (system.id)}
				<div class="system">
					<span class="system-name">{system.name}</span>
					<div class="chips">
						{#each system.roles as role (role)}
							<label class="chip">
								<input type="checkbox" value="{system.id}#{role}" bind:group={picked} />
								{role}
							</label>
						{/each}
					</div>
				</div>
			{:else}
				<span class="muted">{empty}</span>
			{/each}
		{:else}
			<div class="chips">
				{#each roles as role (role)}
					<label class="chip"><input type="checkbox" value={role} bind:group={picked} /> {role}</label>
				{:else}
					<span class="muted">{empty}</span>
				{/each}
			</div>
		{/if}
	</fieldset>

	<fieldset class="group section">
		<legend>Code</legend>
		<div class="code">
			<input name="code" bind:value={code} required aria-label="Voucher code" spellcheck="false" />
			<button type="button" class="secondary" onclick={() => (code = suggestVoucherCode())}>New code</button>
		</div>
		<p class="hint">Case and separators don't matter when redeeming.</p>
	</fieldset>

	<div class="fields">
		<fieldset class="group">
			<legend>Valid (UTC)</legend>
			<div class="pair">
				<label>From <input type="datetime-local" name="startsAt" value={utcInputValue(quarter.start)} /></label>
				<label>Until <input type="datetime-local" name="endsAt" value={utcInputValue(quarter.end)} /></label>
			</div>
			<p class="hint">This quarter, {quarter.label}, by default. Leave empty for no limit.</p>
		</fieldset>

		<fieldset class="group">
			<legend>Terms</legend>
			<div class="pair">
				<label>Discount % <input type="number" name="discountPercent" min="0" max="100" step="1" bind:value={discount} /></label>
				<label>Max uses <input type="number" name="maxUses" min="1" step="1" placeholder="Unlimited" /></label>
			</div>
			<p class="hint" class:warn={discount < 100}>
				{discount < 100 ? 'Below 100% needs payment, which is not available yet.' : '100% grants the roles on redemption.'}
			</p>
		</fieldset>
	</div>

	<div class="footer">
		<span class="summary">
			{#if picked.length}
				Grants <strong>{pickedLabels.join(', ')}</strong>{#if code}{' '}with <code>{code}</code>{/if}
			{:else}
				<span class="muted">Pick at least one role.</span>
			{/if}
		</span>
		<button disabled={!picked.length}>Create voucher</button>
	</div>
	{#if created}<p class="ok created">Voucher created: <code>{created}</code></p>{/if}
</form>

<style>
	.voucher-form {
		display: flex;
		flex-direction: column;
		gap: 1.1rem;
		padding: 1rem 1.1rem;
		background: var(--card);
		border: 1px solid var(--line);
		border-radius: 8px;
	}
	.group {
		margin: 0;
		padding: 0;
		border: none;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	legend {
		padding: 0;
		margin-bottom: 0.4rem;
		font-size: 0.75rem;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--muted);
	}
	.hint {
		margin: 0;
		font-size: 0.8rem;
		color: var(--muted);
	}
	.hint.warn {
		color: var(--warn);
	}
	.system {
		display: grid;
		grid-template-columns: minmax(6rem, 10rem) 1fr;
		gap: 0.75rem;
		align-items: baseline;
		padding: 0.35rem 0;
	}
	.system + .system {
		border-top: 1px dashed var(--line);
	}
	.system-name {
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	@media (max-width: 520px) {
		.system {
			grid-template-columns: 1fr;
			gap: 0.3rem;
		}
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.25rem 0.75rem;
		border: 1px solid var(--line);
		border-radius: 999px;
		background: var(--bg);
		cursor: pointer;
		user-select: none;
	}
	.chip:hover {
		border-color: var(--muted);
	}
	.chip:has(input:checked) {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 18%, var(--bg));
	}
	.chip input {
		margin: 0;
		accent-color: var(--accent);
	}
	.section,
	.fields {
		padding-top: 1rem;
		border-top: 1px solid var(--line);
	}
	.fields {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
		gap: 1.1rem 1.5rem;
	}
	.code {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		max-width: 28rem;
	}
	.code input {
		flex: 1 1 15rem;
		min-width: 0;
		font-family: ui-monospace, 'SF Mono', Menlo, monospace;
		letter-spacing: 0.03em;
	}
	button.secondary {
		background: none;
		color: var(--accent);
		font-weight: normal;
		white-space: nowrap;
	}
	.pair {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 0.5rem;
	}
	.pair label {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		font-size: 0.8rem;
		color: var(--muted);
		min-width: 0;
	}
	.pair input {
		width: 100%;
		box-sizing: border-box;
	}
	.footer {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding-top: 1rem;
		border-top: 1px solid var(--line);
	}
	.summary {
		overflow-wrap: anywhere;
	}
	.created {
		margin: 0;
	}
</style>
