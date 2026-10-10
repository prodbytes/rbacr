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
	import { coverFor } from '#lib/cover.js';

	let { card, roles = [] }: { card: Card; roles?: string[] } = $props();
	let broken = $state(false);
	// Without a screenshot, a cover drawn for what the system is for (R13).
	let cover = $derived(coverFor(card));
	let gradient = $derived(`cover-${card.id.replace(/[^a-z0-9_-]/g, '-')}`);
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
		<svg class="cover" viewBox="0 0 320 180" role="img" aria-label="{card.name}: {cover.theme.label}">
			<defs>
				<linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
					<stop offset="0" stop-color="hsl({cover.hues[0]} 45% 38%)" />
					<stop offset="1" stop-color="hsl({cover.hues[1]} 50% 20%)" />
				</linearGradient>
			</defs>
			<rect width="320" height="180" fill="url(#{gradient})" />
			<circle cx="270" cy="30" r="70" fill="#fff" opacity="0.06" />
			<circle cx="40" cy="170" r="55" fill="#000" opacity="0.12" />
			<g transform="translate(112 42) scale(4)" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.9">
				{#each cover.theme.icon as d (d)}<path {d} />{/each}
			</g>
		</svg>
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
	.cover {
		display: block;
		width: 100%;
		aspect-ratio: 16 / 9;
		object-fit: cover;
		object-position: top;
		border-bottom: 1px solid var(--line);
		background: var(--bg);
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
