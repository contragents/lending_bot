import {HL_CHAIN, type ChainType, WATCH_ADDRESS, getEnv} from "../config.js";
import {ethers} from "ethers";
import {Position} from "./Position.js";
import type {LendingLeverageInstruction} from "../utils/invest_legal/recommend.js";
import {ExchangeClient, HttpTransport, InfoClient} from "@nktkas/hyperliquid";
import {formatPrice, formatSize, SymbolConverter} from "@nktkas/hyperliquid/utils";
import {withRetry} from "../utils/utils.js";

const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";
const SUPPORTED_CHAINS: readonly ChainType[] = [HL_CHAIN];

type HyperliquidPositionData = {
    coin: string;
    szi: string;
    leverage: {
        type: string;
        value: number;
    };
    entryPx: string;
    positionValue: string;
    unrealizedPnl: string;
    liquidationPx: string | null;
    marginUsed: string;
};

type ClearinghouseState = {
    marginSummary: { accountValue: string };
    crossMaintenanceMarginUsed: string;
    assetPositions: { position: HyperliquidPositionData }[];
};

type SpotTokenBalance = {
    coin: string;
    total: string;
};

type SpotClearinghouseState = {
    balances: SpotTokenBalance[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function isNumericString(value: unknown): value is string {
    return typeof value === "string" && Number.isFinite(Number(value));
}

function isHyperliquidPosition(value: unknown): value is HyperliquidPositionData {
    if (!isRecord(value) || !isRecord(value.leverage)) return false;

    return typeof value.coin === "string"
        && isNumericString(value.szi)
        && typeof value.leverage.type === "string"
        && typeof value.leverage.value === "number"
        && Number.isFinite(value.leverage.value)
        && isNumericString(value.entryPx)
        && isNumericString(value.positionValue)
        && isNumericString(value.unrealizedPnl)
        && (value.liquidationPx === null || isNumericString(value.liquidationPx))
        && isNumericString(value.marginUsed);
}

function isClearinghouseState(value: unknown): value is ClearinghouseState {
    return isRecord(value)
        && isRecord(value.marginSummary)
        && isNumericString(value.marginSummary.accountValue)
        && isNumericString(value.crossMaintenanceMarginUsed)
        && Array.isArray(value.assetPositions)
        && value.assetPositions.every((entry: unknown) =>
            isRecord(entry) && isHyperliquidPosition(entry.position));
}

function isSpotClearinghouseState(value: unknown): value is SpotClearinghouseState {
    return isRecord(value)
        && Array.isArray(value.balances)
        && value.balances.every((entry: unknown) =>
            isRecord(entry)
            && typeof entry.coin === "string"
            && isNumericString(entry.total));
}

async function postToHyperliquidInfo(type: string): Promise<unknown> {
    const response = await fetch(HYPERLIQUID_INFO_URL, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({type, user: WATCH_ADDRESS}),
        signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
        throw new Error(`Hyperliquid API returned HTTP ${response.status} for type ${type}`);
    }

    return response.json();
}

export class HLPosition extends Position {
    protected readonly lendingId = 6;
    static readonly SUPPORTED_CHAINS: ChainType[] = [HL_CHAIN];

    protected positionLoaded = false;

    /**
     * @param amount количество токена для разлупки
     * @param loop Массив Токен-количество
     */
    async loop(amount: number, loop: LendingLeverageInstruction): Promise<void> {
        const entries = Object.entries(loop.borrow ?? {})
            .filter(([coin]) => !coin.trim().toUpperCase().startsWith("USD"));

        if (entries.length === 0 && Object.entries(loop.supply ?? {}).length === 0) {
            console.log("HL loop: no perpetual orders to place");

            return;
        }

        console.log('Borrows', entries, 'Supplys', loop.supply ?? {});

        for (const [coin, size] of entries) {
            if (!coin.trim()) {
                throw new Error("Hyperliquid loop contains an empty coin symbol");
            }

            if (!Number.isFinite(size) || size <= 0) {
                throw new Error(`Invalid Hyperliquid loop size for ${coin}: ${size}`);
            }
        }

        const privateKey = getEnv("HYPER_KEY");
        const address = ethers.getAddress(getEnv("HYPER_ADDRESS"));
        const wallet = new ethers.Wallet(privateKey);
        const transport = new HttpTransport();
        const info = new InfoClient({transport});

        if (wallet.address.toLowerCase() !== address.toLowerCase()) {
            const agents = await withRetry(() => info.extraAgents({user: address}));
            const isAuthorizedAgent = agents.some(agent =>
                agent.address.toLowerCase() === wallet.address.toLowerCase()
                && (agent.validUntil === null || agent.validUntil > Date.now()));
            if (!isAuthorizedAgent) {
                throw new Error(
                    `HYPER_KEY address ${wallet.address} is neither HYPER_ADDRESS nor its active API agent`
                );
            }
        }

        const [mids, converter] = await Promise.all([
            withRetry(() => info.allMids()),
            withRetry(() => SymbolConverter.create({transport})),
        ]);
        const orders = entries.map(([coin, size]) => {
            const assetId = converter.getAssetId(coin);
            const sizeDecimals = converter.getSzDecimals(coin);
            const mid = Number(mids[coin]);
            if (assetId === undefined || sizeDecimals === undefined) {
                throw new Error(`Unknown Hyperliquid perpetual asset: ${coin}`);
            }
            if (!Number.isFinite(mid) || mid <= 0) {
                throw new Error(`Missing or invalid Hyperliquid mid price for ${coin}`);
            }

            return {
                a: assetId,
                b: false,
                p: formatPrice(mid * 0.99, sizeDecimals),
                s: formatSize(size, sizeDecimals),
                r: false,
                t: {limit: {tif: "Ioc" as const}},
                c: ethers.hexlify(ethers.randomBytes(16)) as `0x${string}`,
            };
        });

        const exchange = new ExchangeClient({transport, wallet});
        const result = await withRetry(() => exchange.order({orders, grouping: "na"}));
        const statuses = result.response.data.statuses;
        if (statuses.length !== orders.length) {
            throw new Error(`Hyperliquid returned ${statuses.length} order statuses for ${orders.length} orders`);
        }

        const incompleteOrders: string[] = [];
        statuses.forEach((status, index) => {
            const coin = entries[index]![0];
            if (typeof status !== "object" || status === null || !("filled" in status)) {
                incompleteOrders.push(`${coin}: ${JSON.stringify(status)}`);
                return;
            }
            console.log(`HL loop: opened short ${status.filled.totalSz} ${coin} at ${status.filled.avgPx} USDC`);
            const requestedSize = Number(orders[index]!.s);
            if (Number(status.filled.totalSz) < requestedSize) {
                incompleteOrders.push(`${coin}: filled ${status.filled.totalSz} of ${orders[index]!.s}`);
            }
        });
        if (incompleteOrders.length > 0) {
            throw new Error(`Hyperliquid loop orders were not fully filled: ${incompleteOrders.join("; ")}`);
        }
    }

    /**
     * @param amount количество токена для разлупки
     * @param deloop Массив Токен-количество
     */
    async deLoop(amount: number, deloop: LendingLeverageInstruction): Promise<void> {
        console.log('HL deloop', deloop);
        const privateKey = getEnv('HYPER_KEY');
        const address=getEnv('HYPER_ADDRESS');

        console.log('Borrows', deloop.borrow, 'Supplys', deloop.supply ?? {});
        return;
    }

    async getPosition(): Promise<boolean> {
        super.getPosition();

        try {
            const [marginRes, spotRes] = await Promise.all([
                postToHyperliquidInfo("clearinghouseState"),
                postToHyperliquidInfo("spotClearinghouseState"),
            ]);

            if (!isClearinghouseState(marginRes)) {
                throw new Error("Unexpected Hyperliquid clearinghouse state response");
            }
            if (!isSpotClearinghouseState(spotRes)) {
                throw new Error("Unexpected Hyperliquid spot clearinghouse state response");
            }

            const usdcSpot = spotRes.balances.find(balance => balance.coin === "USDC");
            const totalUsdcSpotValue = usdcSpot ? Number(usdcSpot.total) : 0;
            const positions = marginRes.assetPositions
                .map(({position}) => position)
                .filter(position => Number(position.szi) !== 0);
            for (const position of positions) {
                const side = Number(position.szi) > 0 ? "supply" : "borrow";
                this.assets[side][position.coin] =
                    (this.assets[side][position.coin] ?? 0) + Math.abs(Number(position.szi));
            }

            const totalUnrealizedPnl = positions.reduce(
                (sum, position) => sum + Number(position.unrealizedPnl),
                0
            );
            const totalEquity = totalUsdcSpotValue + totalUnrealizedPnl;

            console.log(`Total Balance (Site Style): ${totalEquity.toFixed(6)} USDC`);
            console.log(`  ├─ Total Equity: ${totalUsdcSpotValue.toFixed(6)} USDC`);
            console.log(`  └─ Total Perps uPnL: ${totalUnrealizedPnl.toFixed(6)} USDC`);

            const maintenanceMargin = Number(marginRes.crossMaintenanceMarginUsed);
            const marginRatio = totalEquity > 0 ? (maintenanceMargin / totalEquity) * 100 : 0;
            const liquidationBuffer = totalEquity - maintenanceMargin;
            console.log("--- Риск-Метрики Ликвидации ---");
            console.log(`  🚨 Maintenance Margin: ${maintenanceMargin.toFixed(2)} USDC`);
            console.log(`  📊 Margin Ratio: ${marginRatio.toFixed(2)}% ${marginRatio > 80 ? "🔴 ВНИМАНИЕ!" : "🟢 БЕЗОПАСНО"}`);
            console.log(`  🛡️ Запас до ликвидации: ${liquidationBuffer.toFixed(2)} USDC`);

            const longs = positions.filter(position => Number(position.szi) > 0);
            const shorts = positions.filter(position => Number(position.szi) < 0);
            let sums = {LONG: 0, SHORT: 0};

            for (const [side, sidePositions] of [["LONG", longs], ["SHORT", shorts]] as const) {
                const totalValue = sidePositions.reduce(
                    (sum, position) => sum + Number(position.positionValue),
                    0
                );

                // SUM USDC position for LONG and SHORT separately
                sums[side] = totalValue;

                console.log(`--- ${side} positions (${sidePositions.length}; notional ${totalValue.toFixed(2)} USDC) ---`);
                if (sidePositions.length === 0) {
                    console.log("No open positions.");
                    continue;
                }

                console.table(sidePositions.map(position => ({
                    coin: position.coin,
                    size: Math.abs(Number(position.szi)),
                    entryPrice: position.entryPx,
                    positionValue: position.positionValue,
                    unrealizedPnl: position.unrealizedPnl,
                    leverage: `${position.leverage.value}x ${position.leverage.type}`,
                    marginUsed: position.marginUsed,
                    liquidationPrice: position.liquidationPx ?? "n/a",
                })));


            }

            // Correcting borrow position
            this.assets.borrow["USDC"] = sums.LONG - sums.SHORT - totalUsdcSpotValue;

            this.positionLoaded = true;

            return true;
        } catch (error) {
            console.error("Ошибка при получении позиций Hyperliquid:", error);

            return false;
        }
    }

    async reportPosition(): Promise<boolean> {
        if (!this.positionLoaded) {
            throw new Error("Call getPosition() before reportPosition()");
        }

        try {
            const url = this.createReportUrl(this.createReportParams(this.assets));
            const response = await fetch(url.href);
            const text = await response.text();
            console.log(url.href, text);
            return text === "OK";
        } catch (error) {
            console.error("Ошибка при отправке позиций Hyperliquid:", error);
            return false;
        }
    }
}
