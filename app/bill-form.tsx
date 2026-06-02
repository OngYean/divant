"use client";

import { useState } from "react";

type PoolMember = {
	id: string;
	name: string;
	isOwner: boolean;
};

type BillShare = {
	userId: string;
	shareAmount: number;
	shareValue?: number;
};

type BillFormProps = {
	isBusy: boolean;
	poolMembers: PoolMember[];
	currentUserId: string;
	initialTitle?: string;
	initialAmount?: string;
	initialSplitMode?: "equal" | "custom" | "fixed";
	initialShares?: BillShare[];
	onSubmit: (title: string, amount: number, splitMode: "equal" | "custom" | "fixed", shares: BillShare[]) => void;
	onCancel: () => void;
	accentColor?: "emerald" | "yellow";
};

export default function BillForm({
	isBusy,
	poolMembers,
	currentUserId,
	initialTitle = "",
	initialAmount = "",
	initialSplitMode = "equal",
	initialShares = [],
	onSubmit,
	onCancel,
	accentColor = "emerald",
}: BillFormProps) {
	const [title, setTitle] = useState(initialTitle);
	const [amount, setAmount] = useState(initialAmount);
	const [splitMode, setSplitMode] = useState<"equal" | "custom" | "fixed">(initialSplitMode);
	
	const [includedUsers, setIncludedUsers] = useState<Set<string>>(() => {
		if (initialShares.length > 0) {
			return new Set(initialShares.map((s) => s.userId));
		}
		return new Set(poolMembers.map((m) => m.id));
	});

	const [customValues, setCustomValues] = useState<Record<string, string>>(() => {
		const vals: Record<string, string> = {};
		if (initialShares.length > 0) {
			initialShares.forEach((s) => {
				if (s.shareValue !== undefined) {
					vals[s.userId] = s.shareValue.toString();
				} else if (initialSplitMode === "fixed") {
					vals[s.userId] = s.shareAmount.toString();
				}
			});
		}
		return vals;
	});

	const [error, setError] = useState("");

	const borderColor = accentColor === "emerald" ? "border-emerald-300" : "border-yellow-300";
	const focusColor = accentColor === "emerald" ? "focus:border-emerald-500 focus:ring-emerald-200" : "focus:border-yellow-500 focus:ring-yellow-200";
	const bgLight = accentColor === "emerald" ? "bg-emerald-50" : "bg-yellow-50";
	const bgDark = accentColor === "emerald" ? "bg-emerald-600 hover:bg-emerald-500" : "bg-yellow-600 hover:bg-yellow-500";
	const textDark = accentColor === "emerald" ? "text-emerald-900" : "text-yellow-900";
	const checkboxClass = accentColor === "emerald" ? "text-emerald-600 focus:ring-emerald-500" : "text-yellow-600 focus:ring-yellow-500";

	const toggleUser = (userId: string) => {
		const next = new Set(includedUsers);
		if (next.has(userId)) {
			next.delete(userId);
		} else {
			next.add(userId);
		}
		setIncludedUsers(next);
	};

	const setCustomValue = (userId: string, val: string) => {
		setCustomValues((prev) => ({ ...prev, [userId]: val }));
	};

	const handleSubmit = () => {
		setError("");
		if (!title.trim() || !amount || parseFloat(amount) <= 0) {
			setError("Enter a title and amount greater than 0.");
			return;
		}

		const totalAmount = parseFloat(amount);
		if (includedUsers.size === 0) {
			setError("Select at least one member to share the bill.");
			return;
		}

		let shares: BillShare[] = [];

		if (splitMode === "equal") {
			const shareAmount = totalAmount / includedUsers.size;
			shares = Array.from(includedUsers).map((userId) => ({
				userId,
				shareAmount: parseFloat(shareAmount.toFixed(2)),
			}));
		} else if (splitMode === "custom") {
			let totalPercentage = 0;
			shares = Array.from(includedUsers).map((userId) => {
				const pct = parseFloat(customValues[userId] || "0");
				totalPercentage += pct;
				return {
					userId,
					shareValue: pct,
					shareAmount: parseFloat(((totalAmount * pct) / 100).toFixed(2)),
				};
			});
			if (Math.abs(totalPercentage - 100) > 0.01) {
				setError(`Total percentage must be 100%. Current: ${totalPercentage}%`);
				return;
			}
		} else if (splitMode === "fixed") {
			let totalFixed = 0;
			shares = Array.from(includedUsers).map((userId) => {
				const fixed = parseFloat(customValues[userId] || "0");
				totalFixed += fixed;
				return {
					userId,
					shareValue: fixed,
					shareAmount: fixed,
				};
			});
			if (Math.abs(totalFixed - totalAmount) > 0.01) {
				setError(`Total fixed amounts must equal ${totalAmount}. Current: ${totalFixed.toFixed(2)}`);
				return;
			}
		}

		onSubmit(title.trim(), totalAmount, splitMode, shares);
	};

	return (
		<div className={`mt-3 space-y-4 rounded-2xl border ${borderColor} ${bgLight} p-4`}>
			<div className="grid gap-3 sm:grid-cols-2">
				<div>
					<label className={`text-xs font-medium ${textDark}`}>Title</label>
					<input
						type="text"
						value={title}
						onChange={(e) => setTitle(e.target.value)}
						placeholder="Dinner"
						disabled={isBusy}
						className={`mt-1 h-9 w-full rounded-lg border ${borderColor} bg-white px-3 text-sm text-zinc-950 placeholder:text-zinc-400 ${focusColor} focus:ring-2 disabled:opacity-60 outline-none transition`}
					/>
				</div>
				<div>
					<label className={`text-xs font-medium ${textDark}`}>Amount</label>
					<input
						type="number"
						value={amount}
						onChange={(e) => setAmount(e.target.value)}
						placeholder="50.00"
						step="0.01"
						min="0"
						disabled={isBusy}
						className={`mt-1 h-9 w-full rounded-lg border ${borderColor} bg-white px-3 text-sm text-zinc-950 placeholder:text-zinc-400 ${focusColor} focus:ring-2 disabled:opacity-60 outline-none transition`}
					/>
				</div>
			</div>

			<div>
				<label className={`text-xs font-medium ${textDark} mb-1 block`}>Split Mode</label>
				<div className="flex rounded-lg border border-zinc-300 bg-white p-1">
					<button
						type="button"
						onClick={() => setSplitMode("equal")}
						className={`flex-1 rounded-md text-xs font-medium py-1.5 transition ${splitMode === "equal" ? "bg-zinc-100 text-zinc-900 shadow-sm" : "text-zinc-500 hover:text-zinc-900"}`}
					>
						Equal
					</button>
					<button
						type="button"
						onClick={() => setSplitMode("custom")}
						className={`flex-1 rounded-md text-xs font-medium py-1.5 transition ${splitMode === "custom" ? "bg-zinc-100 text-zinc-900 shadow-sm" : "text-zinc-500 hover:text-zinc-900"}`}
					>
						Custom %
					</button>
					<button
						type="button"
						onClick={() => setSplitMode("fixed")}
						className={`flex-1 rounded-md text-xs font-medium py-1.5 transition ${splitMode === "fixed" ? "bg-zinc-100 text-zinc-900 shadow-sm" : "text-zinc-500 hover:text-zinc-900"}`}
					>
						Fixed Amount
					</button>
				</div>
			</div>

			<div className="space-y-2">
				<label className={`text-xs font-medium ${textDark} block`}>Members</label>
				{poolMembers.map((member) => (
					<div key={member.id} className="flex items-center justify-between rounded-lg bg-white p-2 border border-zinc-200">
						<label className="flex items-center gap-2 cursor-pointer min-w-0 flex-1">
							<input
								type="checkbox"
								checked={includedUsers.has(member.id)}
								onChange={() => toggleUser(member.id)}
								disabled={isBusy}
								className={`rounded border-zinc-300 ${checkboxClass}`}
							/>
							<span className="text-sm text-zinc-900 truncate">
								{member.name} {member.id === currentUserId && "(you)"}
							</span>
						</label>
						{includedUsers.has(member.id) && splitMode !== "equal" && (
							<div className="flex items-center gap-1 w-24">
								<input
									type="number"
									value={customValues[member.id] || ""}
									onChange={(e) => setCustomValue(member.id, e.target.value)}
									placeholder="0"
									step="0.01"
									min="0"
									disabled={isBusy}
									className={`h-7 w-full rounded-md border ${borderColor} text-right text-xs text-zinc-950 focus:ring-1 ${focusColor} outline-none transition`}
								/>
								<span className="text-xs text-zinc-500 font-medium">{splitMode === "custom" ? "%" : ""}</span>
							</div>
						)}
					</div>
				))}
			</div>

			{error && <div className="text-xs font-medium text-rose-600">{error}</div>}

			<div className="flex gap-2 pt-2">
				<button
					type="button"
					onClick={handleSubmit}
					disabled={isBusy}
					className={`flex-1 inline-flex h-9 items-center justify-center rounded-lg ${bgDark} text-sm font-semibold text-white transition disabled:opacity-60`}
				>
					Save Bill
				</button>
				<button
					type="button"
					onClick={onCancel}
					disabled={isBusy}
					className={`flex-1 inline-flex h-9 items-center justify-center rounded-lg border ${borderColor} bg-white text-sm font-semibold ${textDark} transition hover:bg-white/50 disabled:opacity-60`}
				>
					Cancel
				</button>
			</div>
		</div>
	);
}
