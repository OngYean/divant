import "server-only";

import crypto from "node:crypto";

import { createPool, type Pool, type PoolOptions } from "mysql2/promise";

export const POOL_SESSION_COOKIE_NAME = "divant_pool_session";
export const POOL_SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

const DEFAULT_POOL_TIMEOUT_HOURS = 168;
const POOL_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

type DatabaseConfig =
	| {
		kind: "url";
		connectionUrl: string;
	}
	| {
		kind: "credentials";
		host: string;
		port: number;
		user: string;
		password: string;
		database: string;
		ssl: boolean;
	};

type SchemaStatus = {
	configured: boolean;
	ready: boolean;
	backend: "mysql";
	tables: string[];
};

export type SessionCookieValue = {
	poolId: string;
	userId: string;
	sessionToken: string;
};

type PoolCache = {
	pool: Pool;
	key: string;
};

const globalForMySql = globalThis as typeof globalThis & {
	divantMySqlPool?: PoolCache;
};

const schemaStatements = [
	`CREATE TABLE IF NOT EXISTS \`pool\` (
		id VARCHAR(64) NOT NULL,
		name VARCHAR(120) NOT NULL,
		created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
		last_active_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
		expires_at TIMESTAMP(3) NOT NULL,
		PRIMARY KEY (id),
		KEY idx_pool_last_active_at (last_active_at),
		KEY idx_pool_expires_at (expires_at)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
	`CREATE TABLE IF NOT EXISTS \`user\` (
		id VARCHAR(64) NOT NULL,
		pool_id VARCHAR(64) NOT NULL,
		name VARCHAR(120) NOT NULL,
		normalized_name VARCHAR(120) NOT NULL,
		session_token_hash CHAR(64) NULL,
		is_owner TINYINT(1) NOT NULL DEFAULT 0,
		joined_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
		last_seen_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
		PRIMARY KEY (id),
		UNIQUE KEY uk_user_pool_normalized_name (pool_id, normalized_name),
		KEY idx_user_pool_last_seen_at (pool_id, last_seen_at),
		CONSTRAINT fk_user_pool
			FOREIGN KEY (pool_id) REFERENCES \`pool\` (id)
			ON DELETE CASCADE
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
	`CREATE TABLE IF NOT EXISTS bill (
		id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
		pool_id VARCHAR(64) NOT NULL,
		created_by_user_id VARCHAR(64) NOT NULL,
		title VARCHAR(160) NOT NULL,
		total_amount DECIMAL(12,2) NOT NULL,
		currency CHAR(3) NOT NULL,
		split_mode ENUM('equal', 'custom', 'fixed') NOT NULL,
		created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
		updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
		PRIMARY KEY (id),
		KEY idx_bill_pool_created_at (pool_id, created_at),
		CONSTRAINT fk_bill_pool
			FOREIGN KEY (pool_id) REFERENCES \`pool\` (id)
			ON DELETE CASCADE,
		CONSTRAINT fk_bill_created_by_user
			FOREIGN KEY (created_by_user_id) REFERENCES \`user\` (id)
			ON DELETE CASCADE
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
	`CREATE TABLE IF NOT EXISTS bill_share (
		id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
		bill_id BIGINT UNSIGNED NOT NULL,
		user_id VARCHAR(64) NOT NULL,
		share_type ENUM('equal', 'custom', 'fixed') NOT NULL,
		share_value DECIMAL(12,2) NULL,
		share_amount DECIMAL(12,2) NOT NULL,
		PRIMARY KEY (id),
		UNIQUE KEY uk_bill_share_bill_user (bill_id, user_id),
		KEY idx_bill_share_bill_id (bill_id),
		KEY idx_bill_share_user_id (user_id),
		CONSTRAINT fk_bill_share_bill
			FOREIGN KEY (bill_id) REFERENCES bill (id)
			ON DELETE CASCADE,
		CONSTRAINT fk_bill_share_user
			FOREIGN KEY (user_id) REFERENCES \`user\` (id)
			ON DELETE CASCADE
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
] as const;

function readDatabaseConfig(): DatabaseConfig | null {
	const connectionUrl = process.env.DATABASE_URL?.trim();
	if (connectionUrl) {
		return {
			kind: "url",
			connectionUrl,
		};
	}

	const host = process.env.MYSQL_HOST?.trim();
	const user = process.env.MYSQL_USER?.trim();
	const password = process.env.MYSQL_PASSWORD ?? "";
	const database = process.env.MYSQL_DATABASE?.trim();
	const port = Number.parseInt(process.env.MYSQL_PORT?.trim() ?? "3306", 10);
	const ssl = process.env.MYSQL_SSL?.trim().toLowerCase() === "true";

	if (!host || !user || !database || Number.isNaN(port)) {
		return null;
	}

	return {
		kind: "credentials",
		host,
		port,
		user,
		password,
		database,
		ssl,
	};
}

function buildCacheKey(config: DatabaseConfig) {
	if (config.kind === "url") {
		return config.connectionUrl;
	}

	return [config.host, config.port, config.user, config.database, config.ssl ? "ssl" : "plain"].join("|");
}

function randomToken(length: number) {
	const bytes = crypto.getRandomValues(new Uint8Array(length));
	let token = "";

	for (const byte of bytes) {
		token += POOL_ALPHABET[byte % POOL_ALPHABET.length];
	}

	return token;
}

export function createPoolId() {
	return `${randomToken(4)}-${randomToken(4)}-${randomToken(4)}`;
}

export function createMemberId() {
	return `usr_${randomToken(4)}${randomToken(4)}`;
}

export function createSessionToken() {
	return `${randomToken(8)}${randomToken(8)}`;
}

export function hashSessionToken(sessionToken: string) {
	return crypto.createHash("sha256").update(sessionToken).digest("hex");
}

export function normalizeMemberName(name: string) {
	return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export function getPoolTimeoutMs() {
	const configuredHours = Number.parseInt(process.env.POOL_TIMEOUT_HOURS?.trim() ?? "", 10);
	const timeoutHours = Number.isFinite(configuredHours) && configuredHours > 0 ? configuredHours : DEFAULT_POOL_TIMEOUT_HOURS;
	return timeoutHours * 60 * 60 * 1000;
}

function buildPool(config: DatabaseConfig) {
	if (config.kind === "url") {
		return createPool(config.connectionUrl);
	}

	const poolOptions: PoolOptions = {
		host: config.host,
		port: config.port,
		user: config.user,
		password: config.password,
		database: config.database,
		waitForConnections: true,
		connectionLimit: 10,
		enableKeepAlive: true,
		keepAliveInitialDelay: 0,
		multipleStatements: false,
		ssl: config.ssl ? {} : undefined,
	};

	return createPool(poolOptions);
}

export function isMySqlConfigured() {
	return readDatabaseConfig() !== null;
}

export function getMySqlPool() {
	const config = readDatabaseConfig();
	if (!config) {
		return null;
	}

	const cacheKey = buildCacheKey(config);
	if (globalForMySql.divantMySqlPool?.key === cacheKey) {
		return globalForMySql.divantMySqlPool.pool;
	}

	const pool = buildPool(config);
	globalForMySql.divantMySqlPool = {
		pool,
		key: cacheKey,
	};

	return pool;
}

export async function ensureMySqlSchema(): Promise<SchemaStatus> {
	const pool = getMySqlPool();
	if (!pool) {
		return {
			configured: false,
			ready: false,
			backend: "mysql",
			tables: [],
		};
	}

	await pool.query("SELECT 1");

	for (const statement of schemaStatements) {
		await pool.query(statement);
	}

	return {
		configured: true,
		ready: true,
		backend: "mysql",
		tables: ["pool", "user", "bill", "bill_share"],
	};
}

export async function closeMySqlPool() {
	const cachedPool = globalForMySql.divantMySqlPool?.pool;
	if (!cachedPool) {
		return;
	}

	await cachedPool.end();
	delete globalForMySql.divantMySqlPool;
}