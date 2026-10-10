<!--
	A system's card (SPEC R13): its screenshot, name, description and, when
	given, the roles someone holds there, with a link into the system (R10).
-->
<script lang="ts" module>
	export interface Card {
		id: string;
		name: string;
		url: string | null;
		description: string | null;
		screenshotUrl: string | null;
		maintenance: boolean;
	}
</script>

<script lang="ts">
	import RoleName from '#lib/RoleName.svelte';

	let { card, roles = [] }: { card: Card; roles?: string[] } = $props();
	let broken = $state(false);
</script>

<article class="card">
	{#if card.screenshotUrl && !broken}
		<img
			src={card.screenshotUrl}
			alt="Screenshot of {card.name}"
			loading="lazy"
			referrerpolicy="no-referrer"
			onerror={() => (broken = true)}
		/>
	{:else}
		<div class="placeholder" aria-hidden="true">{card.name.slice(0, 1).toUpperCase()}</div>
	{/if}
	<div class="body">
		<h3>
			{card.name}
			{#if card.maintenance}<span class="badge maintenance">maintenance</span>{/if}
		</h3>
		{#if card.description}<p class="description">{card.description}</p>{/if}
		{#if roles.length}
			<p class="roles">
				{#each roles as role (role)}<span class="badge"><RoleName {role} url={card.url} /></span>{' '}{/each}
			</p>
		{/if}
		{#if card.url}
			<a class="open" href={card.url} target="_blank" rel="noopener noreferrer">Open {card.name} ↗</a>
		{/if}
	</div>
</article>

<style>
	.card {
		display: flex;
		flex-direction: column;
		background: var(--card);
		border: 1px solid var(--line);
		border-radius: 8px;
		overflow: hidden;
		min-width: 0;
	}
	img,
	.placeholder {
		display: block;
		width: 100%;
		aspect-ratio: 16 / 9;
		object-fit: cover;
		object-position: top;
		border-bottom: 1px solid var(--line);
		background: var(--bg);
	}
	.placeholder {
		display: grid;
		place-items: center;
		font: 700 2.5rem ui-monospace, 'SF Mono', Menlo, monospace;
		color: var(--line);
	}
	.body {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.85rem 1rem 1rem;
		flex: 1;
	}
	h3 {
		margin: 0;
		font-size: 1.05rem;
	}
	p {
		margin: 0;
	}
	.description {
		color: var(--muted);
		white-space: pre-line;
		overflow-wrap: anywhere;
	}
	.maintenance {
		border-color: var(--warn);
		color: var(--warn);
		vertical-align: middle;
	}
	.open {
		margin-top: auto;
		padding-top: 0.25rem;
		font-weight: 600;
	}
</style>
