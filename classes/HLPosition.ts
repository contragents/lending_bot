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

type PreparedPerpetualOrder = {
    intent: PerpetualOrderIntent;
    assetId: number;
    sizeDecimals: number;
    requestedSize: number;
    midPrice: number;
    cloid: `0x${string}`;
    makerOrder: {
        a: number;
        b: boolean;
        p: string;
        s: string;
        r: boolean;
        t: {limit: {tif: "Alo"}};
        c: `0x${string}`;
    };
    submittedAt: number;
};

type MakerSubmission = {
    preparedOrder: PreparedPerpetualOrder;
    makerRejected: boolean;
    makerWasFilled: boolean;
    makerFilledSize: number;
    makerOrderId?: number;
    error?: Error;
};

type MakerOrderSnapshot = {
    orderId: number;
    status: string;
    originalSize: string;
    remainingSize: string;
};

type OrderFillSummary = {
    size: number;
    averagePrice: number;
    totalValue: number;
    fee: number;
    feeToken: string;
    liquidityRole: string;
};

async function getMakerOrderSnapshot(
    info: InfoClient,
    user: string,
    orderId: number | `0x${string}`
): Promise<MakerOrderSnapshot> {
    const currentStatus = await withRetry(() => info.orderStatus({user, oid: orderId}));
    if (currentStatus.status === "order") {
        return {
            orderId: currentStatus.order.order.oid,
            status: currentStatus.order.status,
            originalSize: currentStatus.order.order.origSz,
            remainingSize: currentStatus.order.order.sz,
        };
    }

    const [historicalOrders, openOrders] = await Promise.all([
        withRetry(() => info.historicalOrders({user})),
        withRetry(() => info.frontendOpenOrders({user})),
    ]);
    const matchesOrder = (order: {oid: number; cloid?: `0x${string}` | null}) =>
        typeof orderId === "number" ? order.oid === orderId : order.cloid === orderId;
    const historicalOrder = historicalOrders.find(({order}) => matchesOrder(order));
    if (historicalOrder) {
        return {
            orderId: historicalOrder.order.oid,
            status: historicalOrder.status,
            originalSize: historicalOrder.order.origSz,
            remainingSize: historicalOrder.order.sz,
        };
    }

    const openOrder = openOrders.find(matchesOrder);
    if (openOrder) {
        return {
            orderId: openOrder.oid,
            status: "open",
            originalSize: openOrder.origSz,
            remainingSize: openOrder.sz,
        };
    }

    throw new Error(`Hyperliquid returned unknown order ${String(orderId)}`);
}

async function getOrderFillSummary(
    info: InfoClient,
    user: string,
    orderId: number,
    coin: string,
    startTime: number
): Promise<OrderFillSummary | undefined> {
    const fills = await withRetry(() => info.userFillsByTime({
        user,
        startTime,
        endTime: Date.now(),
    }));
    const orderFills = fills.filter(fill => fill.oid === orderId && fill.coin === coin);
    if (orderFills.length === 0) {
        return undefined;
    }

    const fillValues = orderFills.map(fill => ({
        size: Number(fill.sz),
        price: Number(fill.px),
        fee: Number(fill.fee),
    }));
    if (fillValues.some(fill =>
        !Number.isFinite(fill.size) || fill.size <= 0
        || !Number.isFinite(fill.price) || fill.price <= 0
        || !Number.isFinite(fill.fee))) {
        throw new Error(`Hyperliquid returned invalid fill details for ${coin} order ${orderId}`);
    }

    const feeTokens = new Set(orderFills.map(fill => fill.feeToken));
    if (feeTokens.size !== 1) {
        throw new Error(`Hyperliquid returned multiple fee tokens for ${coin} order ${orderId}`);
    }

    const size = fillValues.reduce((total, fill) => total + fill.size, 0);
    const totalValue = fillValues.reduce((total, fill) => total + fill.size * fill.price, 0);
    const crossedValues = new Set(orderFills.map(fill => fill.crossed));
    return {
        size,
        averagePrice: totalValue / size,
        totalValue,
        fee: fillValues.reduce((total, fill) => total + fill.fee, 0),
        feeToken: orderFills[0]!.feeToken,
        liquidityRole: crossedValues.size > 1
            ? "Mixed maker/taker"
            : orderFills[0]!.crossed ? "Taker" : "Maker",
    };
}

function getFilledOrderSize(status: MakerOrderSnapshot, requestedSize: number): number {
    if (status.status === "filled") {
        return requestedSize;
    }

    const originalSize = Number(status.originalSize);
    const remainingSize = Number(status.remainingSize);
    if (!Number.isFinite(originalSize) || !Number.isFinite(remainingSize)
        || originalSize < 0 || remainingSize < 0 || remainingSize > originalSize) {
        throw new Error("Hyperliquid returned invalid perpetual order size data");
    }
    return Math.min(requestedSize, Math.max(0, originalSize - remainingSize));
}

function logExecutionReport({
    action,
    coin,
    size,
    averagePrice,
    midPrice,
    isBuy,
    totalValue,
    fee,
    feeToken,
    liquidityRole,
}: {
    action: string;
    coin: string;
    size: number;
    averagePrice: number;
    midPrice: number;
    isBuy: boolean;
    totalValue: number;
    fee?: number;
    feeToken?: string;
    liquidityRole: string;
}): void {
    const lossPerUnit = isBuy ? averagePrice - midPrice : midPrice - averagePrice;
    const slippageLossUsdc = lossPerUnit * size;
    const slippagePercent = lossPerUnit / midPrice * 100;
    const totalOrderLoss = fee === undefined
        ? undefined
        : fee + Math.max(0, slippageLossUsdc);

    console.log("==================================================");
    console.log(`🔔 HL СДЕЛКА ИСПОЛНЕНА: ${action.toUpperCase()} ${size} ${coin}`);
    console.log(`   ├─ Цена исполнения: ${averagePrice} USDC (Mid цена: ${midPrice} USDC)`);
    console.log(`   ├─ Общий объем:     ${totalValue.toFixed(4)} USDC`);
    if (fee !== undefined && feeToken !== undefined) {
        console.log(`   ├─ 💸 Комиссия (${liquidityRole}, биржевые fills): ${fee.toFixed(6)} ${feeToken}`);
    } else {
        console.log(`   ├─ 💸 Комиссия (${liquidityRole}): недоступна из данных fills`);
    }
    console.log(
        `   ├─ 📉 Потери от проскальзывания: ${Math.max(0, slippageLossUsdc).toFixed(6)} USDC (${slippagePercent.toFixed(4)}%)`
    );
    if (totalOrderLoss !== undefined) {
        console.log(
            `   └─ 🛑 ИТОГО ИЗДЕРЖКИ НА ВХОДЕ: ${totalOrderLoss.toFixed(6)} USDC (${(totalOrderLoss / totalValue * 100).toFixed(4)}%)`
        );
    } else {
        console.log("   └─ 🛑 ИТОГО ИЗДЕРЖКИ НА ВХОДЕ: комиссия не подтверждена");
    }
    console.log("==================================================");
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
        const preparedOrders: PreparedPerpetualOrder[] = await Promise.all(orderIntents.map(async intent => {
            const {coin, size, isBuy, reduceOnly} = intent;
            const assetId = converter.getAssetId(coin);
            const sizeDecimals = converter.getSzDecimals(coin);
            const mid = Number(mids[coin]);
            if (assetId === undefined || sizeDecimals === undefined) {
                throw new Error(`Unknown Hyperliquid perpetual asset: ${coin}`);
            }
            if (!Number.isFinite(mid) || mid <= 0) {
                throw new Error(`Missing or invalid Hyperliquid mid price for ${coin}`);
            }

            const book = await withRetry(() => info.l2Book({coin}));
            if (!book) {
                throw new Error(`Hyperliquid returned no order book for ${coin}`);
            }
            const bestBid = book.levels[0][0];
            const bestAsk = book.levels[1][0];
            if (!bestBid || !bestAsk) {
                throw new Error(`Hyperliquid order book is missing best bid or ask for ${coin}`);
            }
            const bestBidPrice = Number(bestBid.px);
            const bestAskPrice = Number(bestAsk.px);
            if (!Number.isFinite(bestBidPrice) || bestBidPrice <= 0
                || !Number.isFinite(bestAskPrice) || bestAskPrice <= 0
                || bestBidPrice > bestAskPrice) {
                throw new Error(`Hyperliquid returned an invalid best bid/ask for ${coin}`);
            }

            const makerPrice = isBuy ? bestBid.px : bestAsk.px;
            const makerSize = formatSize(size, sizeDecimals);
            const requestedSize = Number(makerSize);
            if (!Number.isFinite(requestedSize) || requestedSize <= 0) {
                throw new Error(`Hyperliquid order size for ${coin} is below exchange precision`);
            }

            const cloid = ethers.hexlify(ethers.randomBytes(16)) as `0x${string}`;
            const makerOrder: PreparedPerpetualOrder["makerOrder"] = {
                a: assetId,
                b: isBuy,
                p: makerPrice,
                s: makerSize,
                r: reduceOnly,
                t: {limit: {tif: "Alo"}},
                c: cloid,
            };
            console.log(
                `[HL maker] Prepared ${coin} ${isBuy ? "BUY" : "SELL"} ${makerSize} @ ${makerOrder.p}; bestBid=${bestBid.px}; bestAsk=${bestAsk.px}; mid=${mid}; cloid=${cloid}; reduceOnly=${reduceOnly}`
            );
            return {
                intent,
                assetId,
                sizeDecimals,
                requestedSize,
                midPrice: mid,
                cloid,
                makerOrder,
                submittedAt: Date.now(),
            };
        }));

        const exchange = new ExchangeClient({transport, wallet});
        console.log(`[HL maker] Submitting ${preparedOrders.length} ALO order(s) in parallel`);
        const makerSubmissions: MakerSubmission[] = await Promise.all(preparedOrders.map(async preparedOrder => {
            const {intent, makerOrder, requestedSize, cloid} = preparedOrder;
            console.log(
                `[HL maker] Sending ${intent.coin} ${intent.isBuy ? "BUY" : "SELL"} ${makerOrder.s} @ ${makerOrder.p}; cloid=${cloid}`
            );
            try {
                const result = await withRetry(() => exchange.order({
                    orders: [makerOrder],
                    grouping: "na",
                }));
                const statuses = result.response.data.statuses;
                if (statuses.length !== 1) {
                    throw new Error(`Hyperliquid returned ${statuses.length} ALO statuses for ${intent.coin}`);
                }

                const status = statuses[0]!;
                if (typeof status !== "object" || status === null) {
                    throw new Error(`Unexpected ALO status for ${intent.coin}: ${JSON.stringify(status)}`);
                }
                if ("error" in status) {
                    console.warn(`[HL maker] ${intent.coin} ALO rejected: ${status.error}`);
                    return {
                        preparedOrder,
                        makerRejected: true,
                        makerWasFilled: false,
                        makerFilledSize: 0,
                    };
                }
                if ("filled" in status) {
                    const filledSize = Number(status.filled.totalSz);
                    if (!Number.isFinite(filledSize) || filledSize < 0 || filledSize > requestedSize) {
                        throw new Error(`Invalid immediate ALO fill size for ${intent.coin}: ${status.filled.totalSz}`);
                    }
                    console.log(`[HL maker] ${intent.coin} filled immediately: ${filledSize} of ${requestedSize}`);
                    return {
                        preparedOrder,
                        makerRejected: false,
                        makerWasFilled: true,
                        makerFilledSize: filledSize,
                        makerOrderId: status.filled.oid,
                    };
                }
                if ("resting" in status) {
                    console.log(`[HL maker] ${intent.coin} ALO resting; oid=${status.resting.oid}`);
                    return {
                        preparedOrder,
                        makerRejected: false,
                        makerWasFilled: false,
                        makerFilledSize: 0,
                        makerOrderId: status.resting.oid,
                    };
                }
                throw new Error(`Unexpected ALO status for ${intent.coin}: ${JSON.stringify(status)}`);
            } catch (error) {
                if (error instanceof Error && error.message.includes("Post only order would have immediately matched")) {
                    console.warn(`[HL maker] ${intent.coin} ALO crossed the book and was rejected; full size goes to IOC`);
                    return {
                        preparedOrder,
                        makerRejected: true,
                        makerWasFilled: false,
                        makerFilledSize: 0,
                    };
                }
                console.error(`[HL maker] ${intent.coin} ALO submission outcome is uncertain; will reconcile by cloid`, error);
                return {
                    preparedOrder,
                    makerRejected: false,
                    makerWasFilled: false,
                    makerFilledSize: 0,
                    error: error instanceof Error ? error : new Error(String(error)),
                };
            }
        }));

        console.log(`[HL maker] All submissions resolved; waiting ${MAKER_ORDER_WAIT_MS} ms`);
        await sleep(MAKER_ORDER_WAIT_MS);

        const orderResults = await Promise.all(makerSubmissions.map(async submission => {
            const {preparedOrder} = submission;
            const {intent, assetId, sizeDecimals, requestedSize, cloid, submittedAt} = preparedOrder;
            const {coin, isBuy, reduceOnly, action} = intent;
            try {
                let filledSize = submission.makerFilledSize;
                let makerOrderId = submission.makerOrderId;
                let remainingSize = Math.max(0, requestedSize - filledSize);
                let makerSnapshot: MakerOrderSnapshot | undefined;

                if (submission.error) {
                    console.log(`[HL maker] Resolving ${coin} uncertain submission via cloid=${cloid}`);
                    makerSnapshot = await getMakerOrderSnapshot(info, address, cloid);
                    makerOrderId = makerSnapshot.orderId;
                } else if (!submission.makerRejected && !submission.makerWasFilled) {
                    if (makerOrderId === undefined) {
                        throw new Error(`Missing order ID for accepted ${coin} ALO order`);
                    }
                    makerSnapshot = await getMakerOrderSnapshot(info, address, makerOrderId);
                }

                if (makerSnapshot) {
                    console.log(`[HL maker] ${coin} status=${makerSnapshot.status}`);
                    if (makerSnapshot.status === "open" || makerSnapshot.status === "triggered") {
                        if (makerOrderId === undefined) {
                            throw new Error(`Missing order ID for active ${coin} maker order`);
                        }
                        console.log(`[HL maker] Canceling remaining ${coin} ALO order oid=${makerOrderId}`);
                        await withRetry(() => exchange.cancel({
                            cancels: [{a: assetId, o: makerOrderId!}],
                        }));
                        const openOrders = await withRetry(() => info.frontendOpenOrders({user: address}));
                        if (openOrders.some(order => order.oid === makerOrderId)) {
                            throw new Error(`Maker order for ${coin} is still open after cancellation; IOC blocked`);
                        }
                        makerSnapshot = await getMakerOrderSnapshot(info, address, makerOrderId);
                        if (makerSnapshot.status === "open" || makerSnapshot.status === "triggered") {
                            throw new Error(`Maker order for ${coin} remains active after cancellation; IOC blocked`);
                        }
                    }
                    filledSize = getFilledOrderSize(makerSnapshot, requestedSize);
                    remainingSize = Math.max(0, requestedSize - filledSize);
                }
                if (submission.makerRejected) {
                    console.log(`[HL maker] ${coin} maker order rejected; full size ${remainingSize} goes to IOC`);
                }

                if (makerOrderId !== undefined && !submission.makerRejected) {
                    const makerFillSummary = await getOrderFillSummary(
                        info,
                        address,
                        makerOrderId,
                        coin,
                        submittedAt
                    );
                    const actualFilledSize = makerFillSummary?.size ?? 0;
                    if (!Number.isFinite(actualFilledSize) || actualFilledSize < 0
                        || actualFilledSize > requestedSize) {
                        throw new Error(`Invalid maker fill reconciliation for ${coin}: ${actualFilledSize}`);
                    }
                    if (actualFilledSize > 0 && actualFilledSize !== filledSize) {
                        console.log(
                            `[HL maker] ${coin} fill sources differ: status=${filledSize}, userFills=${actualFilledSize}; using the larger confirmed fill`
                        );
                    }
                    filledSize = Math.max(filledSize, actualFilledSize);
                    remainingSize = Math.max(0, requestedSize - filledSize);

                    if (filledSize > 0) {
                        if (makerFillSummary && makerFillSummary.size !== filledSize) {
                            console.warn(
                                `[HL maker] ${coin} userFills report ${makerFillSummary.size} filled, while order status confirms ${filledSize}`
                            );
                        }
                        const reportSize = makerFillSummary?.size || filledSize;
                        const reportPrice = makerFillSummary?.averagePrice
                            ?? Number(preparedOrder.makerOrder.p);
                        const reportValue = makerFillSummary?.totalValue
                            ?? reportSize * reportPrice;
                        logExecutionReport({
                            action,
                            coin,
                            size: reportSize,
                            averagePrice: reportPrice,
                            midPrice: preparedOrder.midPrice,
                            isBuy,
                            totalValue: reportValue,
                            liquidityRole: makerFillSummary?.liquidityRole
                                ?? "Maker (ALO; fills not yet indexed)",
                            ...(makerFillSummary ? {
                                fee: makerFillSummary.fee,
                                feeToken: makerFillSummary.feeToken,
                            } : {}),
                        });
                    }
                }

                if (remainingSize <= 0) {
                    console.log(`[HL orders] ${coin} fully completed by ALO; IOC not needed`);
                    return undefined;
                }

                const freshMids = await withRetry(() => info.allMids());
                const midPrice = Number(freshMids[coin]);
                if (!Number.isFinite(midPrice) || midPrice <= 0) {
                    throw new Error(`Missing or invalid fresh mid for ${coin} IOC fallback`);
                }
                const iocSize = formatSize(remainingSize, sizeDecimals);
                const iocOrder = {
                    a: assetId,
                    b: isBuy,
                    p: formatPrice(midPrice * (isBuy ? 1 + IOC_SLIPPAGE : 1 - IOC_SLIPPAGE), sizeDecimals),
                    s: iocSize,
                    r: reduceOnly,
                    t: {limit: {tif: "Ioc" as const}},
                    c: ethers.hexlify(ethers.randomBytes(16)) as `0x${string}`,
                };
                console.log(
                    `[HL taker] Sending IOC ${coin} ${isBuy ? "BUY" : "SELL"} ${iocSize} @ ${iocOrder.p}; mid=${midPrice}; remaining=${remainingSize}; cloid=${iocOrder.c}`
                );
                const iocResult = await withRetry(() => exchange.order({
                    orders: [iocOrder],
                    grouping: "na",
                }));
                const iocStatuses = iocResult.response.data.statuses;
                if (iocStatuses.length !== 1) {
                    throw new Error(`Hyperliquid returned ${iocStatuses.length} IOC statuses for ${coin}`);
                }
                const iocStatus = iocStatuses[0]!;
                if (typeof iocStatus !== "object" || iocStatus === null || !("filled" in iocStatus)) {
                    throw new Error(`IOC fallback for ${coin} was not fully filled: ${JSON.stringify(iocStatus)}`);
                }
                const iocFilledSize = Number(iocStatus.filled.totalSz);
                const avgPrice = Number(iocStatus.filled.avgPx);
                if (!Number.isFinite(iocFilledSize) || iocFilledSize < Number(iocSize)
                    || !Number.isFinite(avgPrice) || avgPrice <= 0) {
                    throw new Error(`Invalid or partial IOC fill for ${coin}: ${iocStatus.filled.totalSz} of ${iocSize}`);
                }

                const totalValue = iocFilledSize * avgPrice;
                const feePaidUsdc = totalValue * 0.00045;
                const lossPerUnit = isBuy ? avgPrice - midPrice : midPrice - avgPrice;
                const slippageLossUsdc = lossPerUnit * iocFilledSize;
                const slippagePercent = lossPerUnit / midPrice * 100;
                const totalOrderLoss = feePaidUsdc + Math.max(0, slippageLossUsdc);
                console.log("==================================================");
                console.log(`🔔 HL СДЕЛКА ИСПОЛНЕНА: ${action.toUpperCase()} ${iocFilledSize} ${coin}`);
                console.log(`   ├─ Цена исполнения: ${avgPrice} USDC (Mid цена: ${midPrice} USDC)`);
                console.log(`   ├─ Общий объем:     ${totalValue.toFixed(4)} USDC`);
                console.log(`   ├─ 💸 Комиссия (Taker 0.045%): ${feePaidUsdc.toFixed(6)} USDC`);
                console.log(`   ├─ 📉 Потери от проскальзывания: ${Math.max(0, slippageLossUsdc).toFixed(6)} USDC (${slippagePercent.toFixed(4)}%)`);
                console.log(`   └─ 🛑 ИТОГО ИЗДЕРЖКИ НА ВХОДЕ: ${totalOrderLoss.toFixed(6)} USDC (${(totalOrderLoss / totalValue * 100).toFixed(4)}%)`);
                console.log("==================================================");
                return undefined;
            } catch (error) {
                console.error(`[HL orders] Processing failed for ${coin}:`, error);
                return new Error(`Perpetual order processing failed for ${coin}`, {cause: error});
            }
        }));

        const errors = orderResults.filter((result): result is Error => result !== undefined);
        if (errors.length > 0) {
            throw new AggregateError(errors, "One or more Hyperliquid perpetual orders failed");
        }
        console.log(`[HL orders] All ${orderIntents.length} perpetual order(s) completed successfully`);
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
