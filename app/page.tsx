import PoolLauncher from "./pool-launcher";

type PageProps = {
	searchParams?: Promise<{
		pool?: string | string[];
	}>;
};

export default async function Page({ searchParams }: PageProps) {
	const params = await searchParams;
	const initialPoolCode = typeof params?.pool === "string" ? params.pool.trim().toUpperCase() : "";

	return <PoolLauncher initialPoolCode={initialPoolCode} />;
}