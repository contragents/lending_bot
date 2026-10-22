import {HL_CHAIN, type ChainType, WATCH_ADDRESS, getEnv} from "../config.js";
import {ethers} from "ethers";
import {Position} from "./Position.js";
import type {LendingLeverageInstruction} from "../utils/invest_legal/recommend.js";
import {ExchangeClient, HttpTransport, InfoClient} from "@nktkas/hyperliquid";
import {formatPrice, formatSize, SymbolConverter} from "@nktkas/hyperliquid/utils";
import {sleep, withRetry} from "../utils/utils.js";

const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";
const MAKER_ORDER_WAIT_MS = 7_000;
const IOC_SLIPPAGE = 0.01;
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

type PerpetualOrderIntent = {
    coin: string;
    size: number;
    isBuy: boolean;
    reduceOnly: boolean;
    action: string;
};

function getFilledOrderSize(
    status: Awaited<ReturnType<InfoClient["orderStatus"]>>,
    requestedSize: number
): number {
    if (status.status !== "order") {
        throw new Error("Hyperliquid could not find the submitted perpetual order");
    }
    if (status.order.status === "filled") {
        return requestedSize;
    }

    const originalSize = Number(status.order.order.origSz);
    const remainingSize = Number(status.order.order.sz);
    if (!Number.isFinite(originalSize) || !Number.isFinite(remainingSize)
        || originalSize < 0 || remainingSize < 0 || remainingSize > originalSize) {
        throw new Error("Hyperliquid returned invalid perpetual order size data");
    }

    return Math.min(requestedSize, Math.max(0, originalSize - remainingSize));
}

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
        const borrowEntries = Object.entries(loop.borrow ?? {})
            .filter(([coin]) => !coin.trim().toUpperCase().startsWith("USD"));
        const supplyEntries = Object.entries(loop.supply ?? {})
            .filter(([coin]) => !coin.trim().toUpperCase().startsWith("USD"));
        console.log("Borrows", borrowEntries, "Supplys", supplyEntries);

        await this.placePerpetualOrders([
            ...borrowEntries.map(([coin, size]) => ({
                coin,
                size,
                isBuy: false,
                reduceOnly: false,
                action: "opened short",
            })),
            ...supplyEntries.map(([coin, size]) => ({
                coin,
                size,
                isBuy: true,
                reduceOnly: false,
                action: "opened long",
            })),
        ], "HL loop: no perpetual orders to place");
    }

    /**
     * @param amount количество токена для разлупки
     * @param deloop Массив Токен-количество
     */
    async deLoop(amount: number, deloop: LendingLeverageInstruction): Promise<void> {
        const borrowEntries = Object.entries(deloop.borrow ?? {})
            .filter(([coin]) => !coin.trim().toUpperCase().startsWith("USD"));
        const supplyEntries = Object.entries(deloop.supply ?? {})
            .filter(([coin]) => !coin.trim().toUpperCase().startsWith("USD"));
        console.log("HL deloop: closing shorts", borrowEntries, "closing longs", supplyEntries);

        await this.placePerpetualOrders([
            ...borrowEntries.map(([coin, size]) => ({
                coin,
                size,
                isBuy: true,
                reduceOnly: true,
                action: "closed short",
            })),
            ...supplyEntries.map(([coin, size]) => ({
                coin,
                size,
                isBuy: false,
                reduceOnly: true,
                action: "closed long",
            })),
        ], "HL deloop: no perpetual orders to place");
    }

    private async placePerpetualOrders(
        orderIntents: PerpetualOrderIntent[],
        emptyMessage: string
    ): Promise<void> {
        if (orderIntents.length === 0) {
            console.log(emptyMessage);
            return;
        }

        for (const {coin, size} of orderIntents) {
            if (!coin.trim()) {
                throw new Error("Hyperliquid order contains an empty coin symbol");
            }
            if (!Number.isFinite(size) || size <= 0) {
                throw new Error(`Invalid Hyperliquid order size for ${coin}: ${size}`);
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
        const exchange = new ExchangeClient({transport, wallet});

        for (const intent of orderIntents) {
            const {coin, size, isBuy, reduceOnly, action} = intent;
            const assetId = converter.getAssetId(coin);
            const sizeDecimals = converter.getSzDecimals(coin);
            const mid = Number(mids[coin]);
            if (assetId === undefined || sizeDecimals === undefined) {
                throw new Error(`Unknown Hyperliquid perpetual asset: ${coin}`);
            }
            if (!Number.isFinite(mid) || mid <= 0) {
                throw new Error(`Missing or invalid Hyperliquid mid price for ${coin}`);
            }

            const makerSize = formatSize(size, sizeDecimals);
            const requestedSize = Number(makerSize);
            if (!Number.isFinite(requestedSize) || requestedSize <= 0) {
                throw new Error(`Hyperliquid order size for ${coin} is below exchange precision`);
            }

            const cloid = ethers.hexlify(ethers.randomBytes(16)) as `0x${string}`;
            const makerOrder = {
                a: assetId,
                b: isBuy,
                p: formatPrice(mid, sizeDecimals),
                s: makerSize,
                r: reduceOnly,
                t: {limit: {tif: "Gtc" as const}},
                c: cloid,
            };

            const cancelMakerOrder = () => withRetry(() => exchange.cancelByCloid({
                cancels: [{asset: assetId, cloid}],
            }));
            let makerResult;
            try {
                makerResult = await withRetry(() => exchange.order({
                    orders: [makerOrder],
                    grouping: "na",
                }));
            } catch (error) {
                try {
                    await cancelMakerOrder();
                } catch (cancelError) {
                    throw new AggregateError(
                        [error, cancelError],
                        `Maker order submission and cancellation failed for ${coin}; no IOC order was submitted`
                    );
                }
                throw new Error(
                    `Maker order submission failed for ${coin}; cancellation was requested and no IOC order was submitted`,
                    {cause: error}
                );
            }

            const makerStatuses = makerResult.response.data.statuses;
            if (makerStatuses.length !== 1) {
                try {
                    await cancelMakerOrder();
                } catch (cancelError) {
                    throw new Error(
                        `Hyperliquid returned ${makerStatuses.length} maker statuses for ${coin}; cancellation also failed: ${String(cancelError)}`,
                        {cause: cancelError}
                    );
                }
                throw new Error(
                    `Hyperliquid returned ${makerStatuses.length} maker statuses for ${coin}; cancellation was requested and no IOC order was submitted`
                );
            }

            const makerStatus = makerStatuses[0]!;
            let remainingSize = requestedSize;

            if (typeof makerStatus === "object" && makerStatus !== null && "error" in makerStatus) {
                console.error(`Hyperliquid maker order rejected for ${coin}: ${makerStatus.error}`);
            } else {
                await sleep(MAKER_ORDER_WAIT_MS);

                let orderStatus: Awaited<ReturnType<InfoClient["orderStatus"]>>;
                try {
                    orderStatus = await withRetry(() => info.orderStatus({user: address, oid: cloid}));
                } catch (error) {
                    try {
                        await cancelMakerOrder();
                    } catch (cancelError) {
                        throw new AggregateError(
                            [error, cancelError],
                            `Could not verify or cancel maker order for ${coin}; no IOC order was submitted`
                        );
                    }
                    throw new Error(
                        `Could not verify maker order for ${coin}; cancellation was requested and no IOC order was submitted`,
                        {cause: error}
                    );
                }

                if (orderStatus.status === "unknownOid") {
                    try {
                        await cancelMakerOrder();
                    } catch (cancelError) {
                        throw new AggregateError(
                            [new Error(`Hyperliquid returned unknownOid for maker order ${coin}`), cancelError],
                            `Could not confirm or cancel maker order for ${coin}; no IOC order was submitted`
                        );
                    }
                    throw new Error(
                        `Hyperliquid returned unknownOid for maker order ${coin}; cancellation was requested and no IOC order was submitted`
                    );
                }

                if (orderStatus.order.status === "open" || orderStatus.order.status === "triggered") {
                    const cancelResult = await cancelMakerOrder();
                    const cancelStatus = cancelResult.response.data.statuses[0];
                    if (cancelStatus === undefined) {
                        throw new Error(`Hyperliquid returned no cancellation status for ${coin}; no IOC order was submitted`);
                    }

                    const finalStatus = await withRetry(() => info.orderStatus({user: address, oid: cloid}));
                    if (finalStatus.status === "unknownOid") {
                        throw new Error(`Hyperliquid returned unknownOid after canceling maker order for ${coin}; no IOC order was submitted`);
                    }
                    if (finalStatus.order.status === "open" || finalStatus.order.status === "triggered") {
                        throw new Error(
                            `Maker order for ${coin} remains open after cancellation; no IOC order was submitted`
                        );
                    }
                    orderStatus = finalStatus;
                }

                const filledSize = getFilledOrderSize(orderStatus, requestedSize);
                remainingSize = Math.max(0, requestedSize - filledSize);
                console.log(`Hyperliquid maker order ${coin}: filled ${filledSize} of ${requestedSize}`);
            }

            if (remainingSize === 0) {
                continue;
            }

            const fallbackMid = Number((await withRetry(() => info.allMids()))[coin]);
            if (!Number.isFinite(fallbackMid) || fallbackMid <= 0) {
                throw new Error(`Missing or invalid Hyperliquid mid price for ${coin} IOC fallback`);
            }

            const fallbackSize = formatSize(remainingSize, sizeDecimals);
            if (Number(fallbackSize) <= 0) {
                throw new Error(`IOC fallback size for ${coin} is below Hyperliquid size precision`);
            }

            const fallbackOrder = {
                a: assetId,
                b: isBuy,
                p: formatPrice(fallbackMid * (isBuy ? 1 + IOC_SLIPPAGE : 1 - IOC_SLIPPAGE), sizeDecimals),
                s: fallbackSize,
                r: reduceOnly,
                t: {limit: {tif: "Ioc" as const}},
                c: ethers.hexlify(ethers.randomBytes(16)) as `0x${string}`,
            };
            const fallbackResult = await withRetry(() => exchange.order({
                orders: [fallbackOrder],
                grouping: "na",
            }));
            const fallbackStatuses = fallbackResult.response.data.statuses;
            if (fallbackStatuses.length !== 1) {
                throw new Error(
                    `Hyperliquid returned ${fallbackStatuses.length} IOC statuses for ${coin} fallback`
                );
            }

            const fallbackStatus = fallbackStatuses[0]!;
            if (typeof fallbackStatus !== "object" || fallbackStatus === null || !("filled" in fallbackStatus)) {
                throw new Error(`Hyperliquid IOC fallback for ${coin} was not filled: ${JSON.stringify(fallbackStatus)}`);
            }

            const filledSize = Number(fallbackStatus.filled.totalSz);
            const avgPrice = Number(fallbackStatus.filled.avgPx);
            if (!Number.isFinite(filledSize) || !Number.isFinite(avgPrice) || filledSize <= 0 || avgPrice <= 0) {
                throw new Error(`Hyperliquid returned invalid IOC fill data for ${coin}`);
            }
            if (filledSize < Number(fallbackSize)) {
                throw new Error(
                    `Hyperliquid IOC fallback for ${coin} was only partially filled: ${filledSize} of ${fallbackSize}`
                );
            }

            const totalValue = filledSize * avgPrice;
            const feePaidUsdc = totalValue * 0.00045;
            const priceDiff = avgPrice - fallbackMid;
            const lossPerUnit = isBuy ? priceDiff : -priceDiff;
            const slippageLossUsdc = lossPerUnit * filledSize;
            const slippagePercent = (lossPerUnit / fallbackMid) * 100;
            const totalOrderLoss = feePaidUsdc + Math.max(0, slippageLossUsdc);

            console.log(`==================================================`);
            console.log(`🔔 HL СДЕЛКА ИСПОЛНЕНА: ${action.toUpperCase()} ${filledSize} ${coin}`);
            console.log(`   ├─ Цена исполнения: ${avgPrice} USDC (Mid цена: ${fallbackMid} USDC)`);
            console.log(`   ├─ Общий объем:     ${totalValue.toFixed(4)} USDC`);
            console.log(`   ├─ 💸 Комиссия (Taker 0.045%):  ${feePaidUsdc.toFixed(6)} USDC`);
            console.log(`   ├─ 📉 Потери от проскальзывания: ${Math.max(0, slippageLossUsdc).toFixed(6)} USDC (${slippagePercent.toFixed(4)}%)`);
            console.log(`   └─ 🛑 ИТОГО ПОТЕРЬ НА ВХОДЕ:    ${Math.abs(1 - (totalOrderLoss - totalValue) / totalValue) * 100}%)`);
            console.log(`==================================================`);
        }
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

}
