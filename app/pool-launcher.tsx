"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import Link from "next/link";
import QRCode from "react-qr-code";
import BillForm from "./bill-form";

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

type BillShare = {
	userId: string;
	shareAmount: number;
	shareValue?: number;
	isPaid?: boolean;
	offsetAmount?: number;
	paidAt?: string;
};

type Bill = {
	id: number;
	poolId: string;
	createdByUserId: string;
	title: string;
	totalAmount: number;
	currency: string;
	splitMode: "equal" | "custom" | "fixed";
	shares: BillShare[];
	createdAt: string;
	updatedAt: string;
};

type UserBalance = {
	userId: string;
	owes: Array<{ toUserId: string; amount: number }>;
	owed: Array<{ fromUserId: string; amount: number }>;
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
	title?: string;
	subtitle?: string;
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<section className={`flex flex-col rounded-3xl border border-zinc-200/80 bg-white/90 p-4 shadow-[0_24px_60px_rgba(15,23,42,0.08)] backdrop-blur sm:p-5 ${className}`}>
			{title || subtitle ? (
				<div className="mb-3 sm:mb-4">
					{title ? <h2 className="text-base font-semibold text-zinc-950">{title}</h2> : null}
					{subtitle ? <p className="mt-1 text-sm leading-6 text-zinc-600">{subtitle}</p> : null}
				</div>
			) : null}
			<div className="overflow-x-hidden pr-1">{children}</div>
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

export default function PoolLauncher({ initialPoolCode, host }: { initialPoolCode: string; host?: string }) {
	const [sessionLoaded, setSessionLoaded] = useState(false);
	const [origin] = useState(() => {
		if (typeof window === "undefined") return "";
		if (host) {
			const cleanHost = host.trim();
			if (cleanHost.includes("://")) {
				return cleanHost;
			}
			return `${window.location.protocol}//${cleanHost}`;
		}
		return window.location.origin;
	});
	const [poolCode, setPoolCode] = useState(initialPoolCode);
	const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
	const [createPoolName, setCreatePoolName] = useState("");
	const [createOwnerName, setCreateOwnerName] = useState("");
	const [joinCode, setJoinCode] = useState(formatShareCode(initialPoolCode));
	const [joinName, setJoinName] = useState("");
	const [notice, setNotice] = useState<{ tone: NoticeTone; title: string; detail: string } | null>(null);
	const [invitePoolName, setInvitePoolName] = useState<string | null>(null);
	const [loadingInvitePool, setLoadingInvitePool] = useState(false);
	const [showShareModal, setShowShareModal] = useState(false);
	const isInviteMode = useMemo(() => {
		if (!poolCode) return false;
		if (!activeSession) return true;
		return activeSession.pool.id.toUpperCase() !== poolCode.toUpperCase();
	}, [poolCode, activeSession]);
	const [isBusy, setIsBusy] = useState(false);

	function clearInviteUrl() {
		if (typeof window !== "undefined") {
			window.history.replaceState(null, "", window.location.pathname);
		}
		setPoolCode("");
	}

	const [bills, setBills] = useState<Bill[]>([]);
	const [balances, setBalances] = useState<Record<string, UserBalance>>({});
	const [showCreateBill, setShowCreateBill] = useState(false);
	const [editingBillId, setEditingBillId] = useState<number | null>(null);
	const [showPaymentProgressBillId, setShowPaymentProgressBillId] = useState<number | null>(null);
	const [showViewBillId, setShowViewBillId] = useState<number | null>(null);
	const [showMySharesOnly, setShowMySharesOnly] = useState<boolean>(true);

	const wsRef = useRef<WebSocket | null>(null);
	const activePoolRef = useRef<string | null>(null);
	const activeMemberRef = useRef<PoolMember | null>(null);

	// Auto-dismiss notice after 5 seconds
	useEffect(() => {
		if (!notice) return;
		const timer = setTimeout(() => {
			setNotice(null);
		}, 5000);
		return () => clearTimeout(timer);
	}, [notice]);

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
				} catch (e) { }
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

				if (type === 'bill_created' || type === 'bill_updated' || type === 'bill_deleted') {
					// Reload bills and balances when any bill change occurs
					(async () => {
						if (!activePoolRef.current) return;
						try {
							const billsResp = await fetch(`/api/pools/${activePoolRef.current}/bills`, { cache: 'no-store' });
							if (billsResp.ok) {
								const billsData = await readJson<ApiResponse<{ bills: Bill[] }>>(billsResp);
								setBills(billsData.bills ?? []);
							}

							const balancesResp = await fetch(`/api/pools/${activePoolRef.current}/balances`, { cache: 'no-store' });
							if (balancesResp.ok) {
								const balancesData = await readJson<ApiResponse<{ balances: Record<string, UserBalance> }>>(balancesResp);
								setBalances(balancesData.balances ?? {});
							}
						} catch (e) {
							console.error('Failed to reload bills/balances:', e);
						}
					})();
				}
			} catch (e) {
				// ignore parse errors
			}
		};

		ws.onclose = () => {
			wsRef.current = null;
		};

		return () => {
			try { ws.close(); } catch (e) { }
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

	useEffect(() => {
		if (!poolCode) return;
		if (activeSession && activeSession.pool.id.toUpperCase() === poolCode.toUpperCase()) {
			return;
		}

		let aborted = false;
		async function fetchPoolName() {
			setLoadingInvitePool(true);
			try {
				const res = await fetch(`/api/pools/${encodeURIComponent(poolCode)}`);
				if (!res.ok) {
					throw new Error("Pool not found");
				}
				const data = await res.json();
				if (!aborted && data.ok) {
					setInvitePoolName(data.name);
				}
			} catch (err) {
				console.error("Failed to load pool info:", err);
			} finally {
				if (!aborted) setLoadingInvitePool(false);
			}
		}
		void fetchPoolName();
		return () => {
			aborted = true;
		};
	}, [poolCode, activeSession]);

	useEffect(() => {
		if (!activePool) {
			setBills([]);
			setBalances({});
			return;
		}

		async function loadBillsAndBalances() {
			try {
				const billsResp = await fetch(`/api/pools/${activePool?.id}/bills`, { cache: "no-store" });
				if (billsResp.ok) {
					const billsData = await readJson<ApiResponse<{ bills: Bill[] }>>(billsResp);
					setBills(billsData.bills ?? []);
				}

				const balancesResp = await fetch(`/api/pools/${activePool?.id}/balances`, { cache: "no-store" });
				if (balancesResp.ok) {
					const balancesData = await readJson<ApiResponse<{ balances: Record<string, UserBalance> }>>(balancesResp);
					setBalances(balancesData.balances ?? {});
				}
			} catch (e) {
				console.error("Failed to load bills/balances:", e);
			}
		}

		void loadBillsAndBalances();
	}, [activePool?.id]);

	const inviteUrl = useMemo(() => (activePool ? buildInviteUrl(origin, activePool.id) : ""), [activePool, origin]);

	// ensure we subscribe to pool updates when we have an active session
	useEffect(() => {
		if (!activePool) return;
		const ws = wsRef.current;
		if (!ws) return;

		const sendSubscribe = () => {
			try { ws.send(JSON.stringify({ type: 'subscribe', poolId: activePool.id })); } catch (e) { }
		};

		if (ws.readyState === WebSocket.OPEN) {
			sendSubscribe();
			return;
		}

		const onOpen = () => sendSubscribe();
		ws.addEventListener?.('open', onOpen);
		return () => ws.removeEventListener?.('open', onOpen);
	}, [activePool?.id]);

	// helper to send via websocket
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
				try { doSend({ type: 'subscribe', poolId }); } catch (e) { }
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

			try { doSend(message); } catch (e) { }
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
			try {
				sendWs({ type: 'member_joined', poolId: data.pool.id, member: data.member }, data.pool.id);
			} catch (e) { }
			setJoinCode(formatShareCode(data.pool.id));
			setCreatePoolName("");
			setCreateOwnerName("");
			clearInviteUrl();
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
			} catch (e) { }
			setJoinCode(formatShareCode(data.pool.id));
			setJoinName("");
			clearInviteUrl();
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
			try {
				if (activePool && activeMember) {
					sendWs({ type: 'member_left', poolId: activePool.id, member: activeMember });
					sendWs({ type: 'unsubscribe', poolId: activePool.id });
				}
			} catch (e) { }
			setActiveSession(null);
			clearInviteUrl();
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
			try { sendWs({ type: 'pool_deleted', poolId: activePool.id }); } catch (e) { }

			setActiveSession(null);
			clearInviteUrl();
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

	async function createBill(title: string, amount: number, splitMode: "equal" | "custom" | "fixed", shares: BillShare[]) {
		if (!activePool || !activeMember) return;
		setIsBusy(true);
		try {
			const response = await fetch(`/api/pools/${activePool.id}/bills`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title, totalAmount: amount, splitMode, shares }),
			});
			if (!response.ok) throw new Error("Failed to create bill");
			setNotice({ tone: "success", title: "Bill created", detail: `${title} was split among ${shares.length} member${shares.length === 1 ? "" : "s"}.` });
			setShowCreateBill(false);

			const billsResp = await fetch(`/api/pools/${activePool.id}/bills`, { cache: "no-store" });
			if (billsResp.ok) {
				const billsData = await readJson<ApiResponse<{ bills: Bill[] }>>(billsResp);
				setBills(billsData.bills ?? []);
			}
			const balancesResp = await fetch(`/api/pools/${activePool.id}/balances`, { cache: "no-store" });
			if (balancesResp.ok) {
				const balancesData = await readJson<ApiResponse<{ balances: Record<string, UserBalance> }>>(balancesResp);
				setBalances(balancesData.balances ?? {});
			}
		} catch (error) {
			setNotice({ tone: "error", title: "Could not create bill", detail: error instanceof Error ? error.message : "Try again in a moment." });
		} finally {
			setIsBusy(false);
		}
	}

	async function updateBillData(title: string, amount: number, splitMode: "equal" | "custom" | "fixed", shares: BillShare[]) {
		if (!activePool || editingBillId === null) return;
		setIsBusy(true);
		try {
			const response = await fetch(`/api/pools/${activePool.id}/bills/${editingBillId}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title, totalAmount: amount, splitMode, shares }),
			});
			if (!response.ok) throw new Error("Failed to update bill");
			setNotice({ tone: "success", title: "Bill updated", detail: `${title} has been updated.` });
			setEditingBillId(null);

			const billsResp = await fetch(`/api/pools/${activePool.id}/bills`, { cache: "no-store" });
			if (billsResp.ok) {
				const billsData = await readJson<ApiResponse<{ bills: Bill[] }>>(billsResp);
				setBills(billsData.bills ?? []);
			}
			const balancesResp = await fetch(`/api/pools/${activePool.id}/balances`, { cache: "no-store" });
			if (balancesResp.ok) {
				const balancesData = await readJson<ApiResponse<{ balances: Record<string, UserBalance> }>>(balancesResp);
				setBalances(balancesData.balances ?? {});
			}
		} catch (error) {
			setNotice({ tone: "error", title: "Could not update bill", detail: error instanceof Error ? error.message : "Try again in a moment." });
		} finally {
			setIsBusy(false);
		}
	}

	async function removeBill(billId: number) {
		if (!activePool) {
			return;
		}

		if (!confirm("Delete this bill? This cannot be undone.")) {
			return;
		}

		setIsBusy(true);
		try {
			const response = await fetch(`/api/pools/${activePool.id}/bills/${billId}`, {
				method: "DELETE",
			});

			if (!response.ok) {
				throw new Error("Failed to delete bill");
			}

			setNotice({
				tone: "success",
				title: "Bill deleted",
				detail: "The bill has been removed.",
			});

			setEditingBillId(null);

			// reload bills
			const billsResp = await fetch(`/api/pools/${activePool.id}/bills`, { cache: "no-store" });
			if (billsResp.ok) {
				const billsData = await readJson<ApiResponse<{ bills: Bill[] }>>(billsResp);
				setBills(billsData.bills ?? []);
			}

			// reload balances
			const balancesResp = await fetch(`/api/pools/${activePool.id}/balances`, { cache: "no-store" });
			if (balancesResp.ok) {
				const balancesData = await readJson<ApiResponse<{ balances: Record<string, UserBalance> }>>(balancesResp);
				setBalances(balancesData.balances ?? {});
			}
		} catch (error) {
			setNotice({
				tone: "error",
				title: "Could not delete bill",
				detail: error instanceof Error ? error.message : "Try again in a moment.",
			});
		} finally {
			setIsBusy(false);
		}
	}

	async function reloadData() {
		if (!activePool) return;
		try {
			const billsResp = await fetch(`/api/pools/${activePool.id}/bills`, { cache: "no-store" });
			if (billsResp.ok) {
				const billsData = await readJson<ApiResponse<{ bills: Bill[] }>>(billsResp);
				setBills(billsData.bills ?? []);
			}
			const balancesResp = await fetch(`/api/pools/${activePool.id}/balances`, { cache: "no-store" });
			if (balancesResp.ok) {
				const balancesData = await readJson<ApiResponse<{ balances: Record<string, UserBalance> }>>(balancesResp);
				setBalances(balancesData.balances ?? {});
			}
		} catch (e) {
			console.error("Failed to reload data:", e);
		}
	}

	async function toggleSharePaid(billId: number, targetUserId: string, isPaid: boolean, resetOffset?: boolean) {
		if (!activePool) return;
		setIsBusy(true);
		try {
			const response = await fetch(`/api/pools/${activePool.id}/bills/${billId}/shares`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ isPaid, userId: targetUserId, resetOffset }),
			});
			if (!response.ok) throw new Error("Failed to update payment status");
			setNotice({
				tone: "success",
				title: resetOffset ? "Offset reverted" : (isPaid ? "Share cleared" : "Payment reverted"),
				detail: resetOffset
					? "The offset has been reverted and choices restored."
					: (isPaid ? "The share has been marked as paid." : "The share has been marked as unpaid."),
			});
			await reloadData();
		} catch (error) {
			setNotice({
				tone: "error",
				title: "Could not update payment status",
				detail: error instanceof Error ? error.message : "Try again in a moment.",
			});
		} finally {
			setIsBusy(false);
		}
	}

	async function offsetMutualDebts(partnerId: string) {
		if (!activePool) return;
		setIsBusy(true);
		try {
			const response = await fetch(`/api/pools/${activePool.id}/balances/offset`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ partnerId }),
			});
			if (!response.ok) throw new Error("Failed to offset mutual debts");

			setNotice({
				tone: "success",
				title: "Mutual Debts Offset",
				detail: "Your mutual outstanding debts have been cancelled out.",
			});
			await reloadData();
		} catch (error) {
			setNotice({
				tone: "error",
				title: "Could not offset debts",
				detail: error instanceof Error ? error.message : "Try again in a moment.",
			});
		} finally {
			setIsBusy(false);
		}
	}

	async function settleDebtsToUser(creditorId: string) {
		if (!activePool) return;
		setIsBusy(true);
		try {
			const response = await fetch(`/api/pools/${activePool.id}/balances/settle`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ creditorId }),
			});
			if (!response.ok) throw new Error("Failed to settle debts");

			setNotice({
				tone: "success",
				title: "Debts Settled",
				detail: "All your outstanding shares to this member have been marked as paid.",
			});
			await reloadData();
		} catch (error) {
			setNotice({
				tone: "error",
				title: "Could not settle debts",
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
			<main className="flex items-center justify-center min-h-screen px-3 py-3 text-zinc-950 sm:px-4">
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

	if (isInviteMode) {
		return (
			<main className="flex items-center justify-center min-h-[80vh] px-3 py-3 text-zinc-950 sm:px-4">
				<div className="w-full max-w-sm">
					<div className="mb-5 text-center sm:mb-8">
						<p className="text-xs font-semibold uppercase tracking-[0.24em] text-emerald-600">Divant</p>
						<h1 className="mt-2 text-2xl font-semibold text-zinc-950 sm:mt-3">
							{loadingInvitePool ? "Checking pool..." : `Join ${invitePoolName || `pool ${poolCode}`}`}
						</h1>
						<p className="mt-2 text-sm text-zinc-600">
							You've been invited to join this shared session.
						</p>
					</div>

					<Panel
						title="Enter your name"
						subtitle={invitePoolName ? `Join "${invitePoolName}" to start tracking and splitting expenses.` : "Enter your name to join the pool and start sharing expenses."}
					>
						<form
							onSubmit={(event) => {
								event.preventDefault();
								if (!joinName.trim()) {
									setNotice({
										tone: "error",
										title: "Name is required",
										detail: "Please enter your display name.",
									});
									return;
								}
								void joinPool(poolCode, joinName);
							}}
							className="space-y-3 sm:space-y-4"
						>
							<div>
								<label className="mb-2 block text-sm font-medium text-zinc-800" htmlFor="join-name">Your name</label>
								<input
									id="join-name"
									value={joinName}
									onChange={(event) => setJoinName(event.target.value)}
									placeholder="Ari"
									disabled={isBusy}
									className="h-12 w-full rounded-2xl border border-zinc-300 bg-white px-4 text-base text-zinc-950 outline-none transition placeholder:text-zinc-400 focus:border-emerald-500 focus:ring-4 focus:ring-emerald-100 disabled:opacity-60 sm:h-14"
								/>
							</div>
							<button type="submit" disabled={isBusy} className="inline-flex h-12 w-full items-center justify-center rounded-2xl bg-zinc-950 px-4 text-base font-semibold text-white transition hover:bg-zinc-800 disabled:opacity-60 sm:h-14">
								Join pool
							</button>

							{activeSession ? (
								<button
									type="button"
									onClick={() => {
										window.history.replaceState(null, "", window.location.pathname);
										window.location.reload();
									}}
									className="inline-flex h-12 w-full items-center justify-center rounded-2xl border border-zinc-300 bg-white px-4 text-base font-semibold text-zinc-900 transition hover:border-zinc-400 hover:bg-zinc-50 sm:h-14"
								>
									Back to {activeSession.pool.name}
								</button>
							) : null}
						</form>
					</Panel>

					{notice ? (
						<div className={`fixed top-4 left-1/2 -translate-x-1/2 z-50 w-[calc(100%-2rem)] max-w-md rounded-2xl border px-4 py-3 text-sm shadow-lg backdrop-blur-md transition-all duration-300 ${notice.tone === "success"
							? "border-emerald-200 bg-emerald-50/95 text-emerald-900 shadow-emerald-100/50"
							: notice.tone === "error"
								? "border-rose-200 bg-rose-50/95 text-rose-900 shadow-rose-100/50"
								: "border-zinc-200 bg-zinc-50/95 text-zinc-900 shadow-zinc-100/50"
							}`}>
							<div className="flex items-start justify-between gap-2">
								<div className="flex-1">
									<div className="font-semibold">{notice.title}</div>
									<div className="mt-1 leading-relaxed text-xs opacity-90">{notice.detail}</div>
								</div>
								<button
									onClick={() => setNotice(null)}
									className="text-zinc-400 hover:text-zinc-600 transition p-1 -mr-1"
									aria-label="Close notification"
								>
									<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
										<path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
									</svg>
								</button>
							</div>
						</div>
					) : null}
				</div>
			</main>
		);
	}

	if (activePool && activeMember) {
		return (
			<main className="w-full px-3 py-3 text-zinc-950 sm:px-4 lg:px-6">
				<div className="mx-auto w-full max-w-5xl flex flex-col gap-3">
					<header className="rounded-[1.5rem] border border-zinc-200 bg-white/85 p-4 shadow-sm flex items-center justify-between gap-3">
						<div>
							<p className="text-xs font-semibold uppercase tracking-[0.24em] text-emerald-600">Current pool</p>
							<h1 className="text-lg font-semibold text-zinc-950">{activePool.name}</h1>
						</div>
						<div className="text-right">
							<p className="text-xs font-medium uppercase tracking-[0.24em] text-zinc-400">You are</p>
							<p className="text-sm font-semibold text-zinc-950">{activeMember.name} ({activeMember.isOwner ? "Owner" : "Member"})</p>
						</div>
					</header>

					<div className="grid gap-3 grid-cols-[5fr_7fr]">
						<Panel>
							<div className="flex flex-col gap-2 h-full justify-center py-4">
								<button
									type="button"
									onClick={() => setShowShareModal(true)}
									className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-emerald-600 px-4 text-sm font-semibold text-white shadow-md transition hover:bg-emerald-500 active:scale-95 cursor-pointer"
								>
									<svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
										<path strokeLinecap="round" strokeLinejoin="round" d="M8.684 10.742l-1.996-1.141c-.496-.283-.496-.994 0-1.278l1.996-1.141m0 7.636l1.996 1.141m0 0a3 3 0 103-5.278 3 3 0 00-3 5.278zM6 16a3 3 0 100-6 3 3 0 000 6zm10-8a3 3 0 100-6 3 3 0 000 6z" />
									</svg>
									Invite
								</button>
								<button
									type="button"
									onClick={leavePool}
									disabled={isBusy}
									className="inline-flex h-12 w-full items-center justify-center rounded-2xl border border-zinc-300 bg-white px-4 text-sm font-semibold text-zinc-900 transition hover:border-zinc-400 hover:bg-zinc-50 disabled:opacity-60 cursor-pointer"
								>
									Leave pool
								</button>
								{activeMember.isOwner ? (
									<button
										type="button"
										onClick={deletePool}
										disabled={isBusy}
										className="inline-flex h-12 w-full items-center justify-center rounded-2xl bg-rose-600 px-4 text-sm font-semibold text-white transition hover:bg-rose-500 disabled:opacity-60 cursor-pointer"
									>
										Delete pool
									</button>
								) : null}
							</div>
						</Panel>

						<Panel>
							<div className="space-y-2 sm:space-y-3">
								{activePool.members.map((member) => (
									<div key={member.id} className="flex items-center justify-between gap-3 rounded-2xl border border-zinc-200 bg-zinc-50 px-3 py-2 sm:px-4 sm:py-3">
										<div>
											<div className={`text-sm font-semibold ${member.isOwner ? "text-emerald-600" : "text-zinc-950"}`}>
												{member.name}
												{member.id === activeMember.id ? " (you)" : ""}
											</div>
											<div className="mt-1 hidden text-xs text-zinc-500 sm:block">Joined {formatDateTime(member.joinedAt)}</div>
										</div>
									</div>
								))}
							</div>
						</Panel>
					</div>

					<Panel title="Balances" subtitle="Who you owe after all expenses.">
						{(() => {
							const myBalance = balances[activeMember.id];
							const myOwes = myBalance?.owes?.filter((owe) => owe.toUserId !== activeMember.id && owe.amount > 0.005) || [];

							if (myOwes.length === 0) {
								return (
									<div className="rounded-2xl border border-dashed border-zinc-300 bg-zinc-50 p-4 text-center text-sm font-medium text-emerald-700">
										You are clear, for now
									</div>
								);
							}

							return (
								<div className="space-y-2">
									{myOwes.map((owe) => {
										const creditor = activePool.members.find((m) => m.id === owe.toUserId);
										const myOwedFromCreditor = myBalance?.owed?.find((o) => o.fromUserId === owe.toUserId)?.amount || 0;
										const hasMutualDebt = myOwedFromCreditor > 0.005;

										return (
											<div key={owe.toUserId} className="rounded-2xl border border-zinc-200 bg-zinc-50 p-3 flex flex-col gap-2 shadow-sm">
												<div className="flex justify-between items-center w-full">
													<span className="text-sm font-medium text-zinc-700">
														You owe <span className="font-semibold text-zinc-950">{creditor?.name || owe.toUserId}</span>
													</span>
													<span className="text-sm font-semibold text-rose-600">
														{bills[0]?.currency || "$"} {owe.amount.toFixed(2)}
													</span>
												</div>
												{hasMutualDebt && (
													<div className="flex items-center justify-between border-t border-zinc-200/60 pt-2 mt-1">
														<span className="text-xs text-zinc-500 font-medium">
															They owe you: <span className="font-semibold text-emerald-600">{bills[0]?.currency || "$"} {myOwedFromCreditor.toFixed(2)}</span>
														</span>
														<button
															type="button"
															onClick={() => offsetMutualDebts(owe.toUserId)}
															disabled={isBusy}
															className="h-7 px-2.5 text-xs font-bold text-emerald-700 bg-emerald-50 rounded-xl border border-emerald-300 hover:bg-emerald-100 disabled:opacity-60 transition cursor-pointer shadow-sm"
														>
															Cancel Out Offset
														</button>
													</div>
												)}
												<div className="flex items-center justify-end border-t border-zinc-200/60 pt-2 mt-1">
													<button
														type="button"
														onClick={() => settleDebtsToUser(owe.toUserId)}
														disabled={isBusy}
														className="h-8 px-3 text-xs font-bold text-white bg-emerald-600 rounded-xl border border-emerald-700 hover:bg-emerald-500 disabled:opacity-60 transition cursor-pointer shadow-sm"
													>
														Settle Debt
													</button>
												</div>
											</div>
										);
									})}
								</div>
							);
						})()}
					</Panel>

					<Panel title="Bills & Splits" subtitle="Track expenses and who owes whom.">
						{bills.length === 0 ? (
							<div className="rounded-2xl border border-dashed border-zinc-300 bg-zinc-50 p-4 text-center text-sm text-zinc-600">
								No bills yet. Create one to get started.
							</div>
						) : (
							<div className="space-y-2">
								<div className="flex items-center mb-2">
									<input
										type="checkbox"
										id="showMySharesOnly"
										checked={showMySharesOnly}
										onChange={() => setShowMySharesOnly(!showMySharesOnly)}
										className="mr-2"
									/>
									<label htmlFor="showMySharesOnly" className="text-sm text-zinc-700">
										Show my shares only
									</label>
								</div>
								{(showMySharesOnly && activeMember ? bills.filter(b => b.shares.some(s => s.userId === activeMember.id)) : bills).map((bill) => {
									const creator = activePool.members.find((m) => m.id === bill.createdByUserId);
									const isCreator = bill.createdByUserId === activeMember.id;
									return (
										<div key={bill.id} className="rounded-2xl border border-zinc-200 bg-zinc-50 p-3 shadow-sm">
											<div className="flex items-start justify-between gap-2">
												<div className="flex-1 min-w-0">
													<div className="font-semibold text-zinc-950 truncate">{bill.title}</div>
													<div className="text-xs text-zinc-600 mt-1">
														{creator?.name} • {bill.currency} {bill.totalAmount.toFixed(2)}
													</div>
												</div>
												<div className="flex gap-1">
													{(() => {
														const canEdit = isCreator && !bill.shares.some((s) => s.isPaid);
														const canDelete = isCreator && bill.shares.every((s) => s.isPaid);
														return isCreator ? (
															<>
																<button
																	type="button"
																	onClick={() => setEditingBillId(bill.id)}
																	disabled={isBusy || !canEdit}
																	className="h-7 px-2 text-xs font-semibold text-zinc-700 rounded border border-zinc-300 hover:bg-zinc-100 disabled:opacity-60"
																>
																	Edit
																</button>
																<button
																	type="button"
																	onClick={() => removeBill(bill.id)}
																	disabled={isBusy || !canDelete}
																	className="h-7 px-2 text-xs font-semibold text-rose-700 rounded border border-rose-300 hover:bg-rose-100 disabled:opacity-60"
																>
																	Delete
																</button>
															</>
														) : (
															<button
																type="button"
																onClick={() => setShowViewBillId(bill.id)}
																disabled={isBusy}
																className="h-7 px-2 text-xs font-semibold text-indigo-700 rounded border border-indigo-300 hover:bg-indigo-100 disabled:opacity-60"
															>
																View
															</button>
														);
													})()}
												</div>
											</div>

											{(() => {
												const myShare = bill.shares.find((s) => s.userId === activeMember.id);
												const myUserId = activeMember?.id;
												const paidSharesCount = bill.shares.filter((s) => s.isPaid && s.userId !== myUserId).length;
												const totalSharesCount = bill.shares.filter((s) => s.userId !== myUserId).length;

												return (
													<div className="mt-2.5 pt-2 border-t border-zinc-200/60 flex flex-wrap items-center justify-between gap-2">
														{myShare && (
															<div className="flex items-center justify-between w-full sm:w-auto gap-2">
																<span className="text-xs text-zinc-500 font-medium">
																	Your Share: <span className="font-semibold text-zinc-950">{bill.currency} {myShare.shareAmount.toFixed(2)}</span>
																	{myShare.offsetAmount !== undefined && myShare.offsetAmount > 0.005 && !myShare.isPaid && (
																		<span className="text-zinc-500"> ({bill.currency} {(myShare.shareAmount - myShare.offsetAmount).toFixed(2)} left)</span>
																	)}
																</span>
																{myShare.isPaid ? (
																	myShare.offsetAmount !== undefined && myShare.offsetAmount >= myShare.shareAmount ? (
																		<span className="inline-flex items-center gap-1 text-[11px] font-bold text-purple-700 bg-purple-50 px-2 py-0.5 rounded-full border border-purple-200">
																			✓ Offset
																		</span>
																	) : (
																		<span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">
																			✓ Paid
																		</span>
																	)
																) : (
																	<span className="inline-flex items-center gap-1 text-[11px] font-bold text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200">
																		Unpaid
																	</span>
																)}
															</div>
														)}

														{isCreator && (
															<button
																type="button"
																onClick={() => setShowPaymentProgressBillId(bill.id)}
																className="inline-flex items-center gap-1.5 text-xs font-semibold text-zinc-700 hover:text-zinc-950 bg-white px-2.5 py-1 rounded-xl border border-zinc-300 hover:bg-zinc-50 transition cursor-pointer shadow-sm ml-auto"
															>
																<svg className="w-3.5 h-3.5 text-zinc-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
																	<path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
																</svg>
																Payments: {paidSharesCount} / {totalSharesCount} paid
															</button>
														)}
													</div>
												);
											})()}
										</div>
									);
								})}
							</div>
						)}

					</Panel>
				</div>

				{notice ? (
					<div className={`fixed top-4 left-1/2 -translate-x-1/2 z-50 w-[calc(100%-2rem)] max-w-md rounded-2xl border px-4 py-3 text-sm shadow-lg backdrop-blur-md transition-all duration-300 ${notice.tone === "success"
						? "border-emerald-200 bg-emerald-50/95 text-emerald-900 shadow-emerald-100/50"
						: notice.tone === "error"
							? "border-rose-200 bg-rose-50/95 text-rose-900 shadow-rose-100/50"
							: "border-zinc-200 bg-zinc-50/95 text-zinc-900 shadow-zinc-100/50"
						}`}>
						<div className="flex items-start justify-between gap-2">
							<div className="flex-1">
								<div className="font-semibold">{notice.title}</div>
								<div className="mt-1 leading-relaxed text-xs opacity-90">{notice.detail}</div>
							</div>
							<button
								onClick={() => setNotice(null)}
								className="text-zinc-400 hover:text-zinc-600 transition p-1 -mr-1"
								aria-label="Close notification"
							>
								<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
									<path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
								</svg>
							</button>
						</div>
					</div>
				) : null}

				{showShareModal ? (
					<div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-zinc-950/65 backdrop-blur-sm">
						<div className="w-full max-w-sm rounded-3xl border border-zinc-200 bg-white p-5 shadow-2xl">
							<div className="flex items-center justify-between mb-4">
								<h3 className="text-base font-semibold text-zinc-950">Invite to Pool</h3>
								<button
									type="button"
									onClick={() => setShowShareModal(false)}
									className="rounded-full p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 transition"
								>
									<svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
										<path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
									</svg>
								</button>
							</div>

							<div className="flex flex-col items-center justify-center gap-4 py-2">
								<div className="rounded-3xl border border-zinc-200 bg-white p-4 shadow-sm flex items-center justify-center">
									{inviteUrl ? <QRCode value={inviteUrl} size={160} /> : null}
								</div>

								<div className="w-full space-y-2 mt-2">
									<div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-3 text-center">
										<span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Share Link</span>
										<p className="mt-1 break-all text-xs text-zinc-900 font-mono select-all leading-normal">{inviteUrl}</p>
									</div>

									<div className="grid grid-cols-2 gap-2 pt-2">
										<button
											type="button"
											onClick={() => {
												void copyInviteLink();
											}}
											className="inline-flex h-12 items-center justify-center rounded-2xl bg-zinc-950 text-sm font-semibold text-white transition hover:bg-zinc-800"
										>
											Copy Link
										</button>
										<button
											type="button"
											onClick={() => {
												void shareInviteLink();
											}}
											className="inline-flex h-12 items-center justify-center rounded-2xl border border-zinc-300 bg-white text-sm font-semibold text-zinc-900 transition hover:border-zinc-400 hover:bg-zinc-50"
										>
											Share
										</button>
									</div>
								</div>
							</div>
						</div>
					</div>
				) : null}

				{showCreateBill && (
					<div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-zinc-950/65 backdrop-blur-sm">
						<div className="w-full max-w-lg rounded-3xl border border-zinc-200 bg-white p-5 shadow-2xl max-h-[90vh] overflow-y-auto">
							<div className="flex items-center justify-between mb-4">
								<h3 className="text-base font-semibold text-zinc-950">Create New Bill</h3>
								<button
									type="button"
									onClick={() => setShowCreateBill(false)}
									className="rounded-full p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 transition"
								>
									<svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
										<path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
									</svg>
								</button>
							</div>

							<BillForm
								isBusy={isBusy}
								poolMembers={activePool.members}
								currentUserId={activeMember.id}
								onSubmit={createBill}
								onCancel={() => setShowCreateBill(false)}
								accentColor="emerald"
							/>
						</div>
					</div>
				)}

				{editingBillId !== null && (() => {
					const editingBill = bills.find((b) => b.id === editingBillId);
					if (!editingBill) return null;
					return (
						<div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-zinc-950/65 backdrop-blur-sm">
							<div className="w-full max-w-lg rounded-3xl border border-zinc-200 bg-white p-5 shadow-2xl max-h-[90vh] overflow-y-auto">
								<div className="flex items-center justify-between mb-4">
									<h3 className="text-base font-semibold text-zinc-950">Edit Bill</h3>
									<button
										type="button"
										onClick={() => setEditingBillId(null)}
										className="rounded-full p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 transition"
									>
										<svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
											<path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
										</svg>
									</button>
								</div>

								<BillForm
									isBusy={isBusy}
									poolMembers={activePool.members}
									currentUserId={activeMember.id}
									initialTitle={editingBill.title}
									initialAmount={editingBill.totalAmount.toString()}
									initialSplitMode={editingBill.splitMode}
									initialShares={editingBill.shares}
									onSubmit={updateBillData}
									onCancel={() => setEditingBillId(null)}
									accentColor="yellow"
								/>
							</div>
						</div>
					);
				})()}

				{showViewBillId !== null && (() => {
					const viewBill = bills.find((b) => b.id === showViewBillId);
					if (!viewBill) return null;
					return (
						<div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-zinc-950/65 backdrop-blur-sm">
							<div className="w-full max-w-lg rounded-3xl border border-zinc-200 bg-white p-5 shadow-2xl max-h-[90vh] overflow-y-auto">
								<div className="flex items-center justify-between mb-4">
									<h3 className="text-base font-semibold text-zinc-950">Bill Details</h3>
									<button
										type="button"
										onClick={() => setShowViewBillId(null)}
										className="rounded-full p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 transition"
									>
										<svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
											<path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
										</svg>
									</button>
								</div>
								<div className="space-y-2">
									<p className="font-semibold">Title: {viewBill.title}</p>
									<p>Total: {viewBill.currency} {viewBill.totalAmount.toFixed(2)}</p>
									<p>Created by: {activePool.members.find(m => m.id === viewBill.createdByUserId)?.name}</p>
									<h4 className="mt-2 font-semibold">Shares</h4>
									<ul className="list-disc list-inside">
										{viewBill.shares.map((s) => (
											<li key={s.userId}>
												{activePool.members.find(m => m.id === s.userId)?.name || s.userId}: {viewBill.currency} {s.shareAmount.toFixed(2)}
												{s.isPaid ? " (Paid)" : ""}
											</li>
										))}
									</ul>
								</div>
							</div>
						</div>
					);
				})()}

				{showPaymentProgressBillId !== null && (() => {
					const targetBill = bills.find((b) => b.id === showPaymentProgressBillId);
					if (!targetBill) return null;
					return (
						<div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-zinc-950/65 backdrop-blur-sm">
							<div className="w-full max-w-md rounded-3xl border border-zinc-200 bg-white p-5 shadow-2xl max-h-[90vh] overflow-y-auto">
								<div className="flex items-center justify-between mb-4">
									<h3 className="text-base font-semibold text-zinc-950">Track Payments</h3>
									<button
										type="button"
										onClick={() => setShowPaymentProgressBillId(null)}
										className="rounded-full p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 transition"
									>
										<svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
											<path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
										</svg>
									</button>
								</div>

								<div className="mb-4">
									<h4 className="text-sm font-bold text-zinc-950">{targetBill.title}</h4>
									<p className="text-xs text-zinc-500 mt-0.5">
										Total: {targetBill.currency} {targetBill.totalAmount.toFixed(2)}
									</p>
								</div>

								<div className="space-y-2">
									{targetBill.shares.map((share) => {
										const member = activePool.members.find((m) => m.id === share.userId);
										const isMe = share.userId === activeMember.id;
										return (
											<div key={share.userId} className="flex items-center justify-between p-3 rounded-2xl border border-zinc-200 bg-zinc-50">
												<div className="min-w-0 flex-1">
													<div className="text-sm font-semibold text-zinc-950 truncate">
														{member?.name || share.userId} {isMe && "(you)"}
													</div>
													<div className="text-xs text-zinc-500 mt-0.5">
														Owes {targetBill.currency} {share.shareAmount.toFixed(2)}
														{share.offsetAmount !== undefined && share.offsetAmount > 0.005 && !share.isPaid && (
															<span className="text-zinc-500"> ({targetBill.currency} {(share.shareAmount - share.offsetAmount).toFixed(2)} left)</span>
														)}
													</div>
												</div>
												<div className="flex items-center gap-2">
													<span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${share.isPaid
														? (share.offsetAmount !== undefined && share.offsetAmount >= share.shareAmount
															? "bg-purple-50 text-purple-700 border-purple-200"
															: "bg-emerald-50 text-emerald-700 border-emerald-200")
														: "bg-amber-50 text-amber-700 border-amber-200"
														}`}>
														{share.isPaid
															? (share.offsetAmount !== undefined && share.offsetAmount >= share.shareAmount ? "Offset" : "Paid")
															: "Pending"}
													</span>
													<button
														type="button"
														onClick={() => {
															if (share.isPaid && share.offsetAmount !== undefined && share.offsetAmount >= share.shareAmount) {
																toggleSharePaid(targetBill.id, share.userId, false, true);
															} else {
																toggleSharePaid(targetBill.id, share.userId, !share.isPaid);
															}
														}}
														disabled={isBusy}
														className={`h-7 px-2.5 text-xs font-bold rounded-xl border transition cursor-pointer ${share.isPaid
															? (share.offsetAmount !== undefined && share.offsetAmount >= share.shareAmount
																? "text-purple-700 bg-purple-50/50 border-purple-300 hover:bg-purple-100"
																: "text-zinc-700 bg-white border-zinc-300 hover:bg-zinc-100")
															: "text-emerald-700 bg-emerald-50 border-emerald-300 hover:bg-emerald-100"
															}`}
													>
														{share.isPaid
															? (share.offsetAmount !== undefined && share.offsetAmount >= share.shareAmount ? "Revert Offset" : "Mark Pending")
															: "Mark Paid"}
													</button>
												</div>
											</div>
										);
									})}
								</div>
							</div>
						</div>
					);
				})()}

				{/* Floating Action Button for New Bill */}
				<button
					type="button"
					onClick={() => setShowCreateBill(true)}
					className="fixed bottom-6 right-6 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-600 text-white shadow-lg shadow-emerald-600/25 transition-all duration-300 hover:bg-emerald-500 hover:scale-110 active:scale-95 cursor-pointer"
					aria-label="New bill"
				>
					<svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
						<path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
					</svg>
				</button>
			</main>
		);
	}

	return (
		<main className="w-full px-3 py-3 text-zinc-950 sm:px-4 lg:px-6">
			<div className="mx-auto w-full max-w-5xl flex flex-col gap-3">
				{/* description moved to /pool-info to make space for create/join UI */}
				<div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[1.05fr_0.95fr]">
					<Panel title="Create a pool">
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

					<Panel title="Join a pool" subtitle="You can also join a pool by the invitation link or by scanning the QR code.">
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
					<div className={`fixed top-4 left-1/2 -translate-x-1/2 z-50 w-[calc(100%-2rem)] max-w-md rounded-2xl border px-4 py-3 text-sm shadow-lg backdrop-blur-md transition-all duration-300 ${notice.tone === "success"
						? "border-emerald-200 bg-emerald-50/95 text-emerald-900 shadow-emerald-100/50"
						: notice.tone === "error"
							? "border-rose-200 bg-rose-50/95 text-rose-900 shadow-rose-100/50"
							: "border-zinc-200 bg-zinc-50/95 text-zinc-900 shadow-zinc-100/50"
						}`}>
						<div className="flex items-start justify-between gap-2">
							<div className="flex-1">
								<div className="font-semibold">{notice.title}</div>
								<div className="mt-1 leading-relaxed text-xs opacity-90">{notice.detail}</div>
							</div>
							<button
								onClick={() => setNotice(null)}
								className="text-zinc-400 hover:text-zinc-600 transition p-1 -mr-1"
								aria-label="Close notification"
							>
								<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
									<path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
								</svg>
							</button>
						</div>
					</div>
				) : null}
			</div>
		</main>
	);
}