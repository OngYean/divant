"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import Link from "next/link";
import QRCode from "react-qr-code";

type PoolMember = {
	id: string;
	name: string;
	normalizedName: string;
	joinedAt: string;
	lastSeenAt: string;
	isOwner: boolean;
};

type PoolRecord = {
	id: string;
	name: string;
	createdAt: string;
	lastActiveAt: string;
	expiresAt: string;
	members: PoolMember[];
};

type ActiveSession = {
	pool: PoolRecord;
	member: PoolMember;
};

type NoticeTone = "success" | "error" | "info";

type ApiResponse<T> = {
	ok: boolean;
	message?: string;
} & T;

function formatDateTime(value: string) {
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(value));
}

function formatExpiresIn(value: string) {
	const remainingMs = new Date(value).getTime() - Date.now();
	if (remainingMs <= 0) {
		return "expires soon";
	}

	const remainingDays = Math.max(1, Math.ceil(remainingMs / (1000 * 60 * 60 * 24)));
	return `${remainingDays} day${remainingDays === 1 ? "" : "s"} left`;
}

function buildInviteUrl(origin: string, poolId: string) {
	return origin ? `${origin}/?pool=${encodeURIComponent(poolId)}` : `/?pool=${encodeURIComponent(poolId)}`;
}

function formatShareCode(input: string) {
	if (!input) return "";
	const alnum = input.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
	const parts = alnum.match(/.{1,4}/g);
	return parts ? parts.join("-") : alnum;
}

function Panel({
	title,
	subtitle,
	children,
	className = "",
}: {
	title: string;
	subtitle?: string;
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<section className={`flex min-h-0 flex-col rounded-3xl border border-zinc-200/80 bg-white/90 p-4 shadow-[0_24px_60px_rgba(15,23,42,0.08)] backdrop-blur sm:p-5 ${className}`}>
			<div className="mb-3 sm:mb-4">
				<h2 className="text-base font-semibold text-zinc-950">{title}</h2>
				{subtitle ? <p className="mt-1 text-sm leading-6 text-zinc-600">{subtitle}</p> : null}
			</div>
			<div className="min-h-0 flex-1">{children}</div>
		</section>
	);
}

function Stat({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4">
			<div className="text-xs font-medium uppercase tracking-[0.18em] text-zinc-500">{label}</div>
			<div className="mt-2 text-lg font-semibold text-zinc-950">{value}</div>
		</div>
	);
}

async function readJson<T>(response: Response) {
	return (await response.json()) as T;
}

export default function PoolLauncher({ initialPoolCode }: { initialPoolCode: string }) {
	const [sessionLoaded, setSessionLoaded] = useState(false);
	const [origin] = useState(() => (typeof window === "undefined" ? "" : window.location.origin));
	const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
	const [createPoolName, setCreatePoolName] = useState("");
	const [createOwnerName, setCreateOwnerName] = useState("");
	const [joinCode, setJoinCode] = useState(formatShareCode(initialPoolCode));
	const [joinName, setJoinName] = useState("");
	const [notice, setNotice] = useState<{ tone: NoticeTone; title: string; detail: string } | null>(null);
	const [isBusy, setIsBusy] = useState(false);
	const wsRef = useRef<WebSocket | null>(null);
	const activePoolRef = useRef<string | null>(null);
	const activeMemberRef = useRef<PoolMember | null>(null);

	// open websocket connection once
	useEffect(() => {
		if (typeof window === 'undefined') return;
		const defaultPort = 3001;
		const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
		const host = window.location.hostname;
		const wsUrl = (window as any).NEXT_PUBLIC_WS_URL || `${proto}://${host}:${defaultPort}`;
		const ws = new WebSocket(wsUrl);
		wsRef.current = ws;

		ws.onopen = () => {
			console.debug('ws connected', wsUrl);
			// if we already know of an active pool, subscribe immediately
			const pid = activePoolRef.current;
			if (pid) {
				try {
					ws.send(JSON.stringify({ type: 'subscribe', poolId: pid }));
					console.debug('ws sent subscribe on open', pid);
				} catch (e) {}
			}
		};

		ws.onmessage = (ev) => {
			console.debug('ws onmessage raw', ev.data);
			try {
				const msg = JSON.parse(ev.data);
				console.debug('ws onmessage', msg);
				const { type, poolId, member } = msg;

				// ignore subscribed ack on client; server-driven broadcasts will arrive
				if (!type) return;

				if (type === 'member_joined') {
					setActiveSession((prev) => {
						if (!prev || prev.pool.id !== poolId) return prev;
						const exists = prev.pool.members.find((m) => m.id === member.id);
						if (exists) return prev;
						const nextPool = { ...prev.pool, members: [...prev.pool.members, member] };
						return { ...prev, pool: nextPool };
					});
				}

				if (type === 'member_left') {
					setActiveSession((prev) => {
						if (!prev || prev.pool.id !== poolId) return prev;
						const nextPool = { ...prev.pool, members: prev.pool.members.filter((m) => m.id !== member.id) };
						return { ...prev, pool: nextPool };
					});
				}

				if (type === 'pool_deleted') {
					setActiveSession((prev) => (prev && prev.pool.id === poolId ? null : prev));
					setNotice({ tone: 'info', title: 'Pool removed', detail: 'This pool was deleted.' });
				}
			} catch (e) {
				// ignore parse errors
			}
		};

		ws.onclose = () => {
			wsRef.current = undefined;
		};

		return () => {
			try { ws.close(); } catch (e) {}
		};
	}, []);

    

	useEffect(() => {
		async function loadSession() {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

			try {
				const response = await fetch("/api/session", {
					method: "GET",
					cache: "no-store",
					signal: controller.signal,
				});
				const data = await readJson<ApiResponse<{ session: ActiveSession | null }>>(response);
				if (data.session) {
					setActiveSession(data.session);
					setJoinCode(formatShareCode(data.session.pool.id));
				}
			} catch (error) {
				const isTimeout = error instanceof Error && error.name === "AbortError";
				setNotice({
					tone: "error",
					title: isTimeout ? "Connection timeout" : "Could not load your pool",
					detail: isTimeout ? "Check your connection and refresh." : "Try again in a moment.",
				});
			} finally {
				clearTimeout(timeoutId);
				setSessionLoaded(true);
			}
		}

		loadSession();
	}, []);

	const activePool = activeSession?.pool ?? null;
	const activeMember = activeSession?.member ?? null;
	useEffect(() => {
		activePoolRef.current = activePool?.id ?? null;
		activeMemberRef.current = activeMember ?? null;
	}, [activePool, activeMember]);
	const inviteUrl = useMemo(() => (activePool ? buildInviteUrl(origin, activePool.id) : ""), [activePool, origin]);

	// hide pool info by default on small screens to save vertical space
	const [showPoolInfo, setShowPoolInfo] = useState(true);

	useEffect(() => {
		if (typeof window === "undefined") return;
		setShowPoolInfo(window.innerWidth >= 640);
	}, []);

		// ensure we subscribe to pool updates when we have an active session
		useEffect(() => {
			if (!activePool) return;
			const ws = wsRef.current;
			if (!ws) return;

			const sendSubscribe = () => {
				try { ws.send(JSON.stringify({ type: 'subscribe', poolId: activePool.id })); } catch (e) {}
			};

			if (ws.readyState === WebSocket.OPEN) {
				sendSubscribe();
				return;
			}

			const onOpen = () => sendSubscribe();
			ws.addEventListener?.('open', onOpen);
			return () => ws.removeEventListener?.('open', onOpen);
		}, [activePool?.id]);

		// helper to send via websocket; if needed, ensure a subscribe is sent before a member_joined
		const pendingSubscribeResolvers = new Map<string, Array<() => void>>();

		async function sendWs(message: any, ensureSubscribeForPool?: string) {
			const ws = wsRef.current;
			if (!ws) return;

			const doSend = (msg: any) => {
				try {
					console.debug('sendWs send', msg);
					ws.send(JSON.stringify(msg));
				} catch (e) { console.debug('sendWs error', e); }
			};

			if (ensureSubscribeForPool) {
				const poolId = ensureSubscribeForPool;
				const sendSubscribe = () => {
					try { doSend({ type: 'subscribe', poolId }); } catch (e) {}
				};

				if (ws.readyState === WebSocket.OPEN) {
					sendSubscribe();
				} else {
					const onopen = () => { sendSubscribe(); ws.removeEventListener('open', onopen); };
					ws.addEventListener('open', onopen);
				}

				// wait for subscribed ack or timeout
				await new Promise<void>((resolve) => {
					const arr = pendingSubscribeResolvers.get(poolId) ?? [];
					let finished = false;
					const cleanup = () => {
						const cur = pendingSubscribeResolvers.get(poolId) ?? [];
						const i = cur.indexOf(wrapped);
						if (i >= 0) cur.splice(i, 1);
						if (cur.length === 0) pendingSubscribeResolvers.delete(poolId);
					};
					const wrapped = () => {
						if (finished) return;
						finished = true;
						clearTimeout(timer);
						cleanup();
						resolve();
					};
					arr.push(wrapped);
					pendingSubscribeResolvers.set(poolId, arr);
					// fallback timeout
					const timer = setTimeout(() => {
						if (finished) return;
						finished = true;
						cleanup();
						resolve();
					}, 2000);
				});

				// after ack or timeout, send the message
				try { doSend(message); } catch (e) {}
				return;
			}

			if (ws.readyState === WebSocket.OPEN) {
				doSend(message);
			} else {
				const onopen = () => {
					doSend(message);
					ws.removeEventListener('open', onopen);
				};
				ws.addEventListener('open', onopen);
			}
		}

	async function createPool(nextPoolName: string, nextOwnerName: string) {
		setIsBusy(true);
		try {
			const response = await fetch("/api/pools", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					poolName: nextPoolName,
					ownerName: nextOwnerName,
				}),
			});
			const data = await readJson<ApiResponse<ActiveSession>>(response);

			if (!response.ok || !data.ok) {
				throw new Error(data.message ?? "Failed to create the pool.");
			}

			setActiveSession({ pool: data.pool, member: data.member });
			// subscribe + broadcast join
			try {
				sendWs({ type: 'member_joined', poolId: data.pool.id, member: data.member }, data.pool.id);
			} catch (e) {}
			setJoinCode(formatShareCode(data.pool.id));
			setCreatePoolName("");
			setCreateOwnerName("");
			setNotice({
				tone: "success",
				title: "Pool created",
				detail: `${data.pool.name} is ready to share.`,
			});
		} catch (error) {
			setNotice({
				tone: "error",
				title: "Could not create the pool",
				detail: error instanceof Error ? error.message : "Try again in a moment.",
			});
		} finally {
			setIsBusy(false);
		}
	}

	async function joinPool(nextJoinCode: string, nextJoinName: string) {
		const poolId = nextJoinCode.trim().toUpperCase();
		setIsBusy(true);
		try {
			const response = await fetch(`/api/pools/${encodeURIComponent(poolId)}/join`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					name: nextJoinName,
				}),
			});
			const data = await readJson<ApiResponse<ActiveSession>>(response);

			if (!response.ok || !data.ok) {
				throw new Error(data.message ?? "Failed to join the pool.");
			}

			setActiveSession({ pool: data.pool, member: data.member });
			try {
				sendWs({ type: 'member_joined', poolId: data.pool.id, member: data.member }, data.pool.id);
			} catch (e) {}
			setJoinCode(formatShareCode(data.pool.id));
			setJoinName("");
			setNotice({
				tone: "success",
				title: data.member.name === nextJoinName.trim() ? "Joined pool" : "Welcome back",
				detail: data.member.name === nextJoinName.trim() ? "You are now in the shared session." : "Your previous name matched this pool.",
			});
		} catch (error) {
			setNotice({
				tone: "error",
				title: "Could not join the pool",
				detail: error instanceof Error ? error.message : "Check the code and try again.",
			});
		} finally {
			setIsBusy(false);
		}
	}

	async function leavePool() {
		setIsBusy(true);
		try {
			await fetch("/api/session", {
				method: "DELETE",
			});
			// notify others before clearing local session
			try {
				if (activePool && activeMember) {
					sendWs({ type: 'member_left', poolId: activePool.id, member: activeMember });
					sendWs({ type: 'unsubscribe', poolId: activePool.id });
				}
			} catch (e) {}
			setActiveSession(null);
			setNotice({
				tone: "info",
				title: "Left the pool",
				detail: "You can rejoin with the same code and name.",
			});
		} finally {
			setIsBusy(false);
		}
	}

	async function deletePool() {
		if (!activePool || !activeMember?.isOwner) {
			return;
		}

		setIsBusy(true);
		try {
			const response = await fetch(`/api/pools/${encodeURIComponent(activePool.id)}`, {
				method: "DELETE",
			});
			const data = await readJson<ApiResponse<Record<string, never>>>(response);
			if (!response.ok || !data.ok) {
				throw new Error(data.message ?? "Failed to delete the pool.");
			}
				// broadcast deletion and clear session
				try { sendWs({ type: 'pool_deleted', poolId: activePool.id }); } catch (e) {}

				setActiveSession(null);
			setNotice({
				tone: "info",
				title: "Pool deleted",
				detail: "The shared pool was removed.",
			});
		} catch (error) {
			setNotice({
				tone: "error",
				title: "Could not delete the pool",
				detail: error instanceof Error ? error.message : "Try again in a moment.",
			});
		} finally {
			setIsBusy(false);
		}
	}

	async function copyInviteLink() {
		if (!inviteUrl) {
			return;
		}

		await navigator.clipboard.writeText(inviteUrl);
		setNotice({
			tone: "success",
			title: "Link copied",
			detail: "Share the link or the square.",
		});
	}

	async function shareInviteLink() {
		if (!inviteUrl || !navigator.share) {
			await copyInviteLink();
			return;
		}

		await navigator.share({
			title: `${activePool?.name ?? "Divant"} pool`,
			text: `Join ${activePool?.name ?? "this pool"} with code ${activePool?.id ?? ""}`,
			url: inviteUrl,
		});
	}

	if (!sessionLoaded) {
		return (
			<main className="flex items-center justify-center overflow-hidden px-3 py-3 text-zinc-950 sm:px-4">
				<div className="w-full max-w-sm">
					<div className="mb-5 text-center sm:mb-8">
						<p className="animate-pulse text-xs font-semibold uppercase tracking-[0.24em] text-emerald-600">Divant</p>
						<h1 className="mt-2 animate-pulse text-2xl font-semibold text-zinc-950 sm:mt-3">Loading pool...</h1>
					</div>
					<div className="rounded-3xl border border-zinc-200 bg-white p-5 shadow-[0_24px_60px_rgba(15,23,42,0.08)] sm:p-6">
						<div className="space-y-3 sm:space-y-4">
							<div className="h-3 w-32 animate-pulse rounded-full bg-zinc-100" />
							<div className="space-y-3">
								<div className="h-4 animate-pulse rounded-2xl bg-zinc-100" />
								<div className="h-4 w-5/6 animate-pulse rounded-2xl bg-zinc-100" />
							</div>
							<div className="pt-1 sm:pt-2">
								<div className="h-12 animate-pulse rounded-2xl bg-zinc-50" />
							</div>
						</div>
					</div>
						<div className="mt-5 space-y-2 text-center text-xs text-zinc-600 sm:mt-8 sm:space-y-3">
						<div className="h-3 w-24 animate-pulse rounded-full bg-zinc-100" />
						<div className="h-3 w-32 animate-pulse rounded-full bg-zinc-100" />
					</div>
				</div>
			</main>
		);
	}

	if (activePool && activeMember) {
		return (
			<main className="flex overflow-hidden px-3 py-3 text-zinc-950 sm:px-4 lg:px-6">
				<div className="mx-auto flex min-h-0 w-full max-w-5xl flex-col gap-3">
					{showPoolInfo ? (
						<header className="rounded-[2rem] border border-zinc-200 bg-white/85 p-4 shadow-[0_28px_70px_rgba(15,23,42,0.08)] backdrop-blur sm:p-5">
							<div className="flex flex-wrap items-start justify-between gap-3">
								<div>
									<p className="text-xs font-semibold uppercase tracking-[0.24em] text-emerald-600">Current pool</p>
									<h1 className="mt-2 text-2xl font-semibold tracking-tight text-zinc-950 sm:text-4xl">{activePool.name}</h1>
									<p className="mt-1 text-sm leading-5 text-zinc-600 sm:mt-2 sm:leading-6">
										You are in as {activeMember.name}. Share code {activePool.id} stays in the link and the square.
									</p>
								</div>
								<div className="rounded-2xl bg-zinc-950 px-3 py-2 text-right text-white shadow-lg sm:px-4 sm:py-3">
									<div className="text-[11px] font-medium uppercase tracking-[0.24em] text-zinc-400">You are</div>
									<div className="mt-1 text-sm font-semibold">{activeMember.isOwner ? "Owner" : "Member"}</div>
								</div>
							</div>
							<div className="mt-3 grid grid-cols-3 gap-2 sm:mt-4 sm:gap-3">
								<Stat label="Members" value={`${activePool.members.length}`} />
								<Stat label="Share code" value={activePool.id} />
								<Stat label="Expires" value={formatExpiresIn(activePool.expiresAt)} />
							</div>
							<div className="mt-3 sm:hidden text-right">
								<button type="button" onClick={() => setShowPoolInfo(false)} className="text-xs font-medium text-zinc-500 hover:underline">
									Hide
								</button>
							</div>
						</header>
					) : (
						<div className="rounded-[1.5rem] border border-zinc-200 bg-white/85 p-3 shadow sm:hidden flex items-center justify-between">
							<div>
								<div className="text-xs font-semibold uppercase tracking-[0.24em] text-emerald-600">Current pool</div>
								<div className="mt-1 text-lg font-semibold text-zinc-950">{activePool.name}</div>
							</div>
							<div className="flex items-center gap-2">
								<button type="button" onClick={() => setShowPoolInfo(true)} className="text-sm font-medium text-emerald-600">
									Details
								</button>
							</div>
						</div>
					)}

					<div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[1.2fr_0.8fr]">
						{showPoolInfo ? (
							<Panel title="Share with others" subtitle="Copy the link or let people scan the square from your phone.">
								<div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px] sm:gap-4">
									<div className="space-y-3">
										<div className="rounded-3xl border border-zinc-200 bg-zinc-50 p-3 sm:p-4">
											<div className="text-xs font-medium uppercase tracking-[0.18em] text-zinc-500">Share link</div>
											<div className="mt-2 break-all text-sm leading-6 text-zinc-900">{inviteUrl}</div>
										</div>
										<div className="grid gap-2 sm:grid-cols-2 sm:gap-3">
											<button type="button" onClick={copyInviteLink} className="inline-flex h-12 items-center justify-center rounded-2xl bg-zinc-950 px-4 text-sm font-semibold text-white transition hover:bg-zinc-800">
												Copy link
											</button>
											<button type="button" onClick={shareInviteLink} className="inline-flex h-12 items-center justify-center rounded-2xl border border-zinc-300 bg-white px-4 text-sm font-semibold text-zinc-900 transition hover:border-zinc-400 hover:bg-zinc-50">
												Share
											</button>
										</div>
									</div>
									<div className="hidden items-center justify-center rounded-3xl border border-zinc-200 bg-white p-4 sm:flex">
										{inviteUrl ? <QRCode value={inviteUrl} size={176} /> : null}
									</div>
								</div>
							</Panel>
						) : (
							<div className="hidden sm:block" />
						)}

						<Panel title="People in the pool" subtitle="The first member is the owner. Everyone else is a joiner.">
							<div className="space-y-2 sm:space-y-3">
								{activePool.members.map((member) => (
									<div key={member.id} className="flex items-center justify-between gap-3 rounded-2xl border border-zinc-200 bg-zinc-50 px-3 py-2 sm:px-4 sm:py-3">
										<div>
											<div className="text-sm font-semibold text-zinc-950">
												{member.name}
												{member.id === activeMember.id ? " (you)" : ""}
											</div>
											<div className="mt-1 hidden text-xs text-zinc-500 sm:block">Joined {formatDateTime(member.joinedAt)}</div>
										</div>
										<span className={`rounded-full px-3 py-1 text-xs font-semibold ${member.isOwner ? "bg-emerald-100 text-emerald-700" : "bg-zinc-200 text-zinc-700"}`}>
											{member.isOwner ? "Owner" : "Member"}
										</span>
									</div>
								))}
							</div>
							<div className="mt-3 flex flex-wrap gap-2 sm:mt-4 sm:gap-3">
								<button type="button" onClick={leavePool} disabled={isBusy} className="inline-flex h-12 items-center justify-center rounded-2xl border border-zinc-300 bg-white px-4 text-sm font-semibold text-zinc-900 transition hover:border-zinc-400 hover:bg-zinc-50 disabled:opacity-60">
									Leave pool
								</button>
								{activeMember.isOwner ? (
									<button type="button" onClick={deletePool} disabled={isBusy} className="inline-flex h-12 items-center justify-center rounded-2xl bg-rose-600 px-4 text-sm font-semibold text-white transition hover:bg-rose-500 disabled:opacity-60">
										Delete pool
									</button>
								) : null}
							</div>
						</Panel>
					</div>

					{notice ? (
						<div className={`rounded-2xl border px-4 py-3 text-sm shadow-sm ${notice.tone === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : notice.tone === "error" ? "border-rose-200 bg-rose-50 text-rose-800" : "border-zinc-200 bg-zinc-50 text-zinc-700"}`}>
							<div className="font-semibold">{notice.title}</div>
							<div className="mt-1 leading-6">{notice.detail}</div>
						</div>
					) : null}
				</div>
			</main>
		);
	}

	return (
		<main className="flex overflow-hidden px-3 py-3 text-zinc-950 sm:px-4 lg:px-6">
			<div className="mx-auto flex min-h-0 w-full max-w-5xl flex-col gap-3">
				{/* description moved to /pool-info to make space for create/join UI */}
				<div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[1.05fr_0.95fr]">
					<Panel title="Create a pool" subtitle="Set the pool name and your display name. You will be dropped into the share screen immediately.">
						<form
							onSubmit={(event) => {
								event.preventDefault();
								if (!createPoolName.trim() || !createOwnerName.trim()) {
									setNotice({
										tone: "error",
										title: "Missing details",
										detail: "Enter both a pool name and your display name.",
									});
									return;
								}

								void createPool(createPoolName, createOwnerName);
							}}
							className="space-y-3 sm:space-y-4"
						>
							<div>
								<label className="mb-2 block text-sm font-medium text-zinc-800" htmlFor="create-pool-name">Pool name</label>
								<input id="create-pool-name" value={createPoolName} onChange={(event) => setCreatePoolName(event.target.value)} placeholder="Friday dinner" disabled={isBusy} className="h-12 w-full rounded-2xl border border-zinc-300 bg-white px-4 text-base text-zinc-950 outline-none transition placeholder:text-zinc-400 focus:border-emerald-500 focus:ring-4 focus:ring-emerald-100 disabled:opacity-60 sm:h-14" />
							</div>
							<div>
								<label className="mb-2 block text-sm font-medium text-zinc-800" htmlFor="create-owner-name">Your name</label>
								<input id="create-owner-name" value={createOwnerName} onChange={(event) => setCreateOwnerName(event.target.value)} placeholder="Ari" disabled={isBusy} className="h-12 w-full rounded-2xl border border-zinc-300 bg-white px-4 text-base text-zinc-950 outline-none transition placeholder:text-zinc-400 focus:border-emerald-500 focus:ring-4 focus:ring-emerald-100 disabled:opacity-60 sm:h-14" />
							</div>
								<button type="submit" disabled={isBusy} className="inline-flex h-12 w-full items-center justify-center rounded-2xl bg-zinc-950 px-4 text-base font-semibold text-white transition hover:bg-zinc-800 disabled:opacity-60 sm:h-14">
								Create pool
							</button>
						</form>
					</Panel>

					<Panel title="Join a pool" subtitle="Enter the shared code and your display name. If your saved details are lost later, joining by the same name will bring you back to the same pool.">
						<form
							onSubmit={(event) => {
								event.preventDefault();
								if (!joinCode.trim() || !joinName.trim()) {
									setNotice({
										tone: "error",
										title: "Missing details",
										detail: "Enter both a share code and your display name.",
									});
									return;
								}

								void joinPool(joinCode, joinName);
							}}
							className="space-y-3 sm:space-y-4"
						>
							<div>
								<label className="mb-2 block text-sm font-medium text-zinc-800" htmlFor="join-code">Share code</label>
								<input
									id="join-code"
									value={joinCode}
									onChange={(event) => setJoinCode(formatShareCode(event.target.value))}
									placeholder="A1B2-C3D4-E5F6"
									disabled={isBusy}
									className="h-12 w-full rounded-2xl border border-zinc-300 bg-white px-4 text-base uppercase tracking-[0.16em] text-zinc-950 outline-none transition placeholder:normal-case placeholder:tracking-normal placeholder:text-zinc-400 focus:border-emerald-500 focus:ring-4 focus:ring-emerald-100 disabled:opacity-60 sm:h-14"
								/>
							</div>
							<div>
								<label className="mb-2 block text-sm font-medium text-zinc-800" htmlFor="join-name">Your name</label>
								<input id="join-name" value={joinName} onChange={(event) => setJoinName(event.target.value)} placeholder="Ari" disabled={isBusy} className="h-12 w-full rounded-2xl border border-zinc-300 bg-white px-4 text-base text-zinc-950 outline-none transition placeholder:text-zinc-400 focus:border-emerald-500 focus:ring-4 focus:ring-emerald-100 disabled:opacity-60 sm:h-14" />
							</div>
								<button type="submit" disabled={isBusy} className="inline-flex h-12 w-full items-center justify-center rounded-2xl border border-zinc-300 bg-white px-4 text-base font-semibold text-zinc-900 transition hover:border-zinc-400 hover:bg-zinc-50 disabled:opacity-60 sm:h-14">
								Join pool
							</button>
						</form>
					</Panel>
				</div>

				<div className="mt-2 text-center">
					<Link href="/pool-info" className="text-sm font-medium text-emerald-600 hover:underline">
						How it works
					</Link>
				</div>

				{notice ? (
					<div className={`rounded-2xl border px-4 py-3 text-sm shadow-sm ${notice.tone === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : notice.tone === "error" ? "border-rose-200 bg-rose-50 text-rose-800" : "border-zinc-200 bg-zinc-50 text-zinc-700"}`}>
						<div className="font-semibold">{notice.title}</div>
						<div className="mt-1 leading-6">{notice.detail}</div>
					</div>
				) : null}
			</div>
		</main>
	);
}