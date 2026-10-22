import {HL_CHAIN, type ChainType, WATCH_ADDRESS, getEnv} from "../config.js";
import {ethers} from "ethers";
import {Position} from "./Position.js";
import type {LendingLeverageInstruction} from "../utils/invest_legal/recommend.js";
import {ExchangeClient, HttpTransport, InfoClient} from "@nktkas/hyperliquid";
import {formatPrice, formatSize, SymbolConverter} from "@nktkas/hyperliquid/utils";
import {sleep, withRetry} from "../utils/utils.js";

const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";
const MAKER_ORDER_WAIT_MS = 7_000;
const MAKER_MAX_MID_DEVIATION_BPS = 5;
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

type MakerOrderSnapshot = {
    orderId: number;
    status: string;
    originalSize: string;
    remainingSize: string;
    source: "orderStatus" | "historicalOrders" | "frontendOpenOrders";
};

function parsePriceUnits(price: string, decimals: number): bigint {
    const [integerPart, fractionalPart = ""] = price.split(".");
    if (fractionalPart.length > decimals && /[1-9]/.test(fractionalPart.slice(decimals))) {
        throw new Error(`Order book price has unexpected precision: ${price}`);
    }

    const scale = 10n ** BigInt(decimals);
    const fraction = fractionalPart.slice(0, decimals).padEnd(decimals, "0");
    return BigInt(integerPart!) * scale + BigInt(fraction || "0");
}

function formatPriceUnits(price: bigint, decimals: number): string {
    const scale = 10n ** BigInt(decimals);
    const integerPart = price / scale;
    const fractionalPart = (price % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
    return fractionalPart ? `${integerPart}.${fractionalPart}` : integerPart.toString();
}

function getMakerPrice(
    bestBidPrice: string,
    bestAskPrice: string,
    sizeDecimals: number,
    isBuy: boolean
): {price: string; mid: number; tick: string} {
    const bestBid = Number(bestBidPrice);
    const bestAsk = Number(bestAskPrice);
    if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid <= 0 || bestAsk <= bestBid) {
        throw new Error(`Invalid Hyperliquid top of book: bid=${bestBidPrice}, ask=${bestAskPrice}`);
    }

    const maxPriceDecimals = Math.max(6 - sizeDecimals, 0);
    const priceExponent = Math.floor(Math.log10((bestBid + bestAsk) / 2)) - 4;
    let tickExponent = Math.max(priceExponent, -maxPriceDecimals);
    if (Number.isInteger(bestBid) && Number.isInteger(bestAsk)) {
        tickExponent = Math.min(tickExponent, 0);
    }

    const priceDecimals = Math.max(maxPriceDecimals, -tickExponent, 0);
    const tick = 10n ** BigInt(priceDecimals + tickExponent);
    const bidUnits = parsePriceUnits(bestBidPrice, priceDecimals);
    const askUnits = parsePriceUnits(bestAskPrice, priceDecimals);
    const midUnitsTimesTwo = bidUnits + askUnits;
    const maxDeviationNumerator = BigInt(10_000 + MAKER_MAX_MID_DEVIATION_BPS);
    const minDeviationNumerator = BigInt(10_000 - MAKER_MAX_MID_DEVIATION_BPS);
    const deviationDenominator = 20_000n;
    const buyDeviationCap = midUnitsTimesTwo * maxDeviationNumerator / deviationDenominator;
    const sellDeviationFloor = (
        midUnitsTimesTwo * minDeviationNumerator + deviationDenominator - 1n
    ) / deviationDenominator;

    let priceUnits: bigint;
    if (isBuy) {
        const bestPassivePrice = askUnits - tick;
        const improvedBidPrice = bidUnits + tick;
        const cappedPrice = [bestPassivePrice, improvedBidPrice, buyDeviationCap]
            .reduce((minimum, value) => value < minimum ? value : minimum);
        priceUnits = cappedPrice / tick * tick;
        if (priceUnits <= 0n || priceUnits >= askUnits) {
            throw new Error(`Could not calculate a passive BUY price inside ${bestBidPrice}@${bestAskPrice}`);
        }
    } else {
        const bestPassivePrice = bidUnits + tick;
        const improvedAskPrice = askUnits - tick;
        const cappedPrice = [bestPassivePrice, improvedAskPrice, sellDeviationFloor]
            .reduce((maximum, value) => value > maximum ? value : maximum);
        priceUnits = (cappedPrice + tick - 1n) / tick * tick;
        if (priceUnits <= bidUnits) {
            throw new Error(`Could not calculate a passive SELL price inside ${bestBidPrice}@${bestAskPrice}`);
        }
    }

    const mid = (bestBid + bestAsk) / 2;
    const price = formatPriceUnits(priceUnits, priceDecimals);
    return {price: formatPrice(price, sizeDecimals), mid, tick: formatPriceUnits(tick, priceDecimals)};
}

async function getMakerOrderSnapshot(
    info: InfoClient,
    user: string,
    orderId: number | `0x${string}`
): Promise<MakerOrderSnapshot> {
    let statusLookupError: unknown;
    try {
        const currentStatus = await withRetry(() => info.orderStatus({user, oid: orderId}));
        if (currentStatus.status === "order") {
            return {
                orderId: currentStatus.order.order.oid,
                status: currentStatus.order.status,
                originalSize: currentStatus.order.order.origSz,
                remainingSize: currentStatus.order.order.sz,
                source: "orderStatus",
            };
        }
    } catch (error) {
        statusLookupError = error;
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
            source: "historicalOrders",
        };
    }

    const openOrder = openOrders.find(matchesOrder);
    if (openOrder) {
        return {
            orderId: openOrder.oid,
            status: "open",
            originalSize: openOrder.origSz,
            remainingSize: openOrder.sz,
            source: "frontendOpenOrders",
        };
    }

    const unknownOrderError = new Error(
        `Hyperliquid returned unknownOid for ${String(orderId)} in orderStatus, historicalOrders, and frontendOpenOrders`
    );
    if (statusLookupError !== undefined) {
        throw new AggregateError(
            [new Error("Hyperliquid orderStatus lookup failed", {cause: statusLookupError}), unknownOrderError],
            `Could not resolve Hyperliquid order ${String(orderId)}`
        );
    }
    throw unknownOrderError;
}

async function getMakerFilledSizeFromTrades(
    info: InfoClient,
    user: string,
    orderId: number,
    coin: string,
    startTime: number
): Promise<number> {
    const fills = await withRetry(() => info.userFillsByTime({
        user,
        startTime,
        endTime: Date.now(),
    }));
    const orderFills = fills.filter(fill => fill.oid === orderId && fill.coin === coin);
    const sizes = orderFills.map(fill => Number(fill.sz));
    if (sizes.some(size => !Number.isFinite(size) || size < 0)) {
        throw new Error(`Hyperliquid returned invalid fill sizes for ${coin} order ${orderId}`);
    }

    return sizes.reduce((total, size) => total + size, 0);
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function isPostOnlyCrossingError(error: unknown): error is Error {
    return error instanceof Error
        && error.message.includes("Post only order would have immediately matched");
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
            // Логируем, что в этот вызов стратегии не попало ордеров.
            console.log(`[HL orders] ${emptyMessage}`);
            return;
        }

        // Показываем размер пакета перед проверкой входных параметров.
        console.log(`[HL orders] Preparing ${orderIntents.length} perpetual order(s)`);
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

        // Отмечаем проверку подписи/API-агента перед обращением к бирже.
        console.log(`[HL orders] Checking exchange signer ${wallet.address} for account ${address}`);
        if (wallet.address.toLowerCase() !== address.toLowerCase()) {
            const agents = await withRetry(() => info.extraAgents({user: address}));
            const isAuthorizedAgent = agents.some(agent =>
                agent.address.toLowerCase() === wallet.address.toLowerCase()
                && (agent.validUntil === null || agent.validUntil > Date.now()));
            if (!isAuthorizedAgent) {
                // Явно показываем отказ авторизации до выхода с ошибкой.
                console.log(`[HL orders] Signer ${wallet.address} is not an active agent for ${address}`);
                throw new Error(
                    `HYPER_KEY address ${wallet.address} is neither HYPER_ADDRESS nor its active API agent`
                );
            }
        }
        // Подтверждаем, что ключ подписи авторизован для аккаунта.
        console.log(`[HL orders] Signer authorization confirmed for ${address}`);

        const converter = await withRetry(() => SymbolConverter.create({transport}));
        console.log("[HL orders] Asset metadata loaded; L2 snapshots will be fetched for maker pricing");
        const exchange = new ExchangeClient({transport, wallet});

        const preparedOrders = await Promise.all(orderIntents.map(async intent => {
            const {coin, size, isBuy, reduceOnly, action} = intent;
            const assetId = converter.getAssetId(coin);
            const sizeDecimals = converter.getSzDecimals(coin);
            if (assetId === undefined || sizeDecimals === undefined) {
                throw new Error(`Unknown Hyperliquid perpetual asset: ${coin}`);
            }

            const book = await withRetry(() => info.l2Book({coin}));
            const bestBid = book?.levels[0][0];
            const bestAsk = book?.levels[1][0];
            if (!bestBid || !bestAsk) {
                throw new Error(`Hyperliquid returned an empty L2 book for ${coin}`);
            }
            const makerPrice = getMakerPrice(bestBid.px, bestAsk.px, sizeDecimals, isBuy);

            const makerSize = formatSize(size, sizeDecimals);
            const requestedSize = Number(makerSize);
            if (!Number.isFinite(requestedSize) || requestedSize <= 0) {
                throw new Error(`Hyperliquid order size for ${coin} is below exchange precision`);
            }

            const cloid = ethers.hexlify(ethers.randomBytes(16)) as `0x${string}`;
            const makerOrder = {
                a: assetId,
                b: isBuy,
                p: makerPrice.price,
                s: makerSize,
                r: reduceOnly,
                t: {limit: {tif: "Alo" as const}},
                c: cloid,
            };

            // Печатаем подготовленные сторону, размер, цену mid и идентификатор maker-ордера.
            console.log(
                `[HL maker] Prepared ${coin} ${isBuy ? "BUY" : "SELL"} ${makerSize} @ ${makerOrder.p}; book=${bestBid.px}@${bestAsk.px}; mid=${makerPrice.mid}; tick=${makerPrice.tick}; maxMidDeviation=${MAKER_MAX_MID_DEVIATION_BPS}bps; cloid=${cloid}; reduceOnly=${reduceOnly}`
            );
            return {
                intent,
                assetId,
                sizeDecimals,
                requestedSize,
                cloid,
                makerOrder,
                submittedAt: Date.now(),
            };
        }));

        // Отмечаем одновременный старт выставления всех maker-лимиток.
        console.log(`[HL maker] Submitting ${preparedOrders.length} ALO order(s) in parallel`);
        const makerSubmissions = await Promise.all(preparedOrders.map(async preparedOrder => {
            const {intent, assetId, cloid, makerOrder, requestedSize} = preparedOrder;
            // Показываем отправку конкретного maker-ордера.
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
                    // Выводим неожиданный размер ответа до обработки ошибки пакета.
                    console.log(`[HL maker] ${intent.coin} returned ${statuses.length} submission status(es), expected 1`);
                    return {
                        preparedOrder,
                        makerRejected: false as const,
                        makerWasFilled: false,
                        makerFilledSize: 0,
                        makerOrderId: undefined,
                        error: new Error(
                            `Hyperliquid returned ${statuses.length} maker statuses for ${intent.coin}`
                        ),
                    };
                }
                const makerStatus = statuses[0]!;
                if (typeof makerStatus === "object" && makerStatus !== null && "error" in makerStatus) {
                    // Показываем биржевой отказ maker-ордера и переход к taker-добиванию.
                    console.error(`Hyperliquid maker order rejected for ${intent.coin}: ${makerStatus.error}`);
                    console.log(`[HL maker] ${intent.coin} rejected by exchange; full requested size will go to IOC fallback`);
                    return {
                        preparedOrder,
                        makerRejected: true as const,
                        makerWasFilled: false,
                        makerFilledSize: 0,
                        makerOrderId: undefined,
                    };
                }
                if (typeof makerStatus === "object" && makerStatus !== null && "filled" in makerStatus) {
                    const makerFilledSize = Number(makerStatus.filled.totalSz);
                    if (!Number.isFinite(makerFilledSize) || makerFilledSize < 0 || makerFilledSize > requestedSize) {
                        return {
                            preparedOrder,
                            makerRejected: false as const,
                            makerWasFilled: false,
                            makerFilledSize: 0,
                            makerOrderId: undefined,
                            error: new Error(
                                `Hyperliquid returned invalid immediate fill size for ${intent.coin}: ${makerStatus.filled.totalSz}`
                            ),
                        };
                    }
                    // Берем немедленное исполнение ALO-ордера из ответа размещения.
                    console.log(
                        `[HL maker] ${intent.coin} filled immediately: ${makerFilledSize} of ${requestedSize} @ ${makerStatus.filled.avgPx}; oid=${makerStatus.filled.oid}`
                    );
                    return {
                        preparedOrder,
                        makerRejected: false as const,
                        makerWasFilled: true,
                        makerFilledSize,
                        makerOrderId: makerStatus.filled.oid,
                    };
                }
                if (typeof makerStatus === "object" && makerStatus !== null && "resting" in makerStatus) {
                    // Сохраняем биржевой OID: последующие запросы статуса выполняются по нему.
                    console.log(
                        `[HL maker] ${intent.coin} ALO order is resting; oid=${makerStatus.resting.oid}; cloid=${cloid}`
                    );
                    return {
                        preparedOrder,
                        makerRejected: false as const,
                        makerWasFilled: false,
                        makerFilledSize: 0,
                        makerOrderId: makerStatus.resting.oid,
                    };
                }
                // Неизвестный формат ответа нельзя безопасно считать размещенной лимиткой.
                console.log(`[HL maker] Unexpected submission status for ${intent.coin}: ${JSON.stringify(makerStatus)}`);
                return {
                    preparedOrder,
                    makerRejected: false as const,
                    makerWasFilled: false,
                    makerFilledSize: 0,
                    makerOrderId: undefined,
                    error: new Error(
                        `Hyperliquid returned an unexpected maker status for ${intent.coin}: ${JSON.stringify(makerStatus)}`
                    ),
                };
            } catch (error) {
                if (isPostOnlyCrossingError(error)) {
                    console.warn(
                        `[HL maker] ${intent.coin} ALO order was rejected because it would cross the book; full size will go to IOC fallback`,
                        error
                    );
                    return {
                        preparedOrder,
                        makerRejected: true as const,
                        makerWasFilled: false,
                        makerFilledSize: 0,
                        makerOrderId: undefined,
                    };
                }
                // Показываем сетевую/SDK ошибку отправки конкретного maker-ордера.
                console.error(`[HL maker] Submission failed for ${intent.coin}; state will be reconciled by cloid`, error);
                return {
                    preparedOrder,
                    makerRejected: false as const,
                    makerWasFilled: false,
                    makerFilledSize: 0,
                    makerOrderId: undefined,
                    error: new Error(`Maker order submission failed for ${intent.coin}`, {cause: error}),
                };
            }
        }));

        const submissionErrorCount = makerSubmissions.filter(result => "error" in result).length;
        if (submissionErrorCount > 0) {
            console.error(
                `[HL maker] ${submissionErrorCount} submission error(s); continuing other coins and reconciling failed submissions by cloid`
            );
        }

        // Показываем начало общей паузы перед запросом статуса всех maker-ордеров.
        console.log(`[HL maker] All submissions resolved; waiting ${MAKER_ORDER_WAIT_MS} ms before status checks`);
        await sleep(MAKER_ORDER_WAIT_MS);
        // Отмечаем окончание паузы и начало параллельной проверки/добивания.
        console.log("[HL maker] Wait complete; checking maker statuses and starting IOC fallbacks in parallel");

        const fallbackResults = await Promise.all(makerSubmissions.map(async submission => {
            const {intent, assetId, sizeDecimals, requestedSize, cloid, submittedAt} = submission.preparedOrder;
            const {coin, isBuy, reduceOnly, action} = intent;
            try {
                let remainingSize = Math.max(0, requestedSize - submission.makerFilledSize);
                let makerOrderId = submission.makerOrderId;
                let orderStatus: MakerOrderSnapshot | undefined;
                if ("error" in submission) {
                    console.error(`[HL maker] ${coin} submission error:`, submission.error);
                    console.log(`[HL maker] Resolving uncertain ${coin} submission by cloid=${cloid}`);
                    orderStatus = await getMakerOrderSnapshot(info, address, cloid);
                    makerOrderId = orderStatus.orderId;
                    console.log(
                        `[HL maker] ${coin} submission reconciled: oid=${makerOrderId}, status=${orderStatus.status} from ${orderStatus.source}`
                    );
                }
                if (!submission.makerRejected && !submission.makerWasFilled) {
                    if (makerOrderId === undefined) {
                        throw new Error(`Missing Hyperliquid order ID for resting maker order ${coin}`);
                    }
                    // Логируем запрос статуса лимитки по биржевому order ID.
                    if (!orderStatus) {
                        console.log(`[HL maker] Checking status for ${coin}; oid=${makerOrderId}; cloid=${cloid}`);
                        try {
                            orderStatus = await getMakerOrderSnapshot(info, address, makerOrderId);
                        } catch (error) {
                            // Показываем причину сбоя status lookup перед переходом к безопасной сверке.
                            console.error(`[HL maker] Status check failed for ${coin}; proceeding with cancel-and-fill reconciliation`, error);
                            let cancelError: unknown;
                            try {
                                const cancelResult = await withRetry(() => exchange.cancel({
                                    cancels: [{a: assetId, o: makerOrderId!}],
                                }));
                                const cancelStatus = cancelResult.response.data.statuses[0];
                                if (cancelStatus === "success") {
                                    console.log(`[HL maker] Cancellation confirmed after status error for ${coin}; oid=${makerOrderId}`);
                                } else {
                                    cancelError = new Error(
                                        `Unexpected cancellation response for ${coin}: ${JSON.stringify(cancelStatus)}`
                                    );
                                    console.log(`[HL maker] ${String(cancelError)}`);
                                }
                            } catch (requestError) {
                                // Не делаем вывод об успешной отмене по ошибке RPC/API.
                                console.log(`[HL maker] Cancellation request failed for ${coin}: ${String(requestError)}`);
                                cancelError = requestError;
                            }
                            const openOrders = await withRetry(() => info.frontendOpenOrders({user: address}));
                            const stillOpen = openOrders.some(order => order.oid === makerOrderId);
                            if (stillOpen) {
                                throw new AggregateError(
                                    [error, cancelError].filter((cause): cause is Error => cause instanceof Error),
                                    `Maker order for ${coin} remains active; no IOC order was submitted`
                                );
                            }

                            if (cancelError) {
                                console.log(`[HL maker] ${coin} is not open; reconciling fills despite cancellation response error`);
                            }
                            const filledSize = await getMakerFilledSizeFromTrades(
                                info,
                                address,
                                makerOrderId,
                                coin,
                                submittedAt
                            );
                            if (!Number.isFinite(filledSize) || filledSize < 0 || filledSize > requestedSize) {
                                throw new Error(
                                    `Hyperliquid fill total for ${coin} is invalid: ${filledSize} of ${requestedSize}`
                                );
                            }
                            remainingSize = Math.max(0, requestedSize - filledSize);
                            console.log(
                                `[HL maker] ${coin} reconciled from user fills: filled=${filledSize}, remaining=${remainingSize}; active order not found`
                            );
                        }
                    }

                    if (orderStatus && (orderStatus.status === "open" || orderStatus.status === "triggered")) {
                        // Показываем статус живой лимитки и запрос отмены ее остатка.
                        console.log(`[HL maker] ${coin} status=${orderStatus.status}; canceling remaining maker size by OID`);
                        const cancelResult = await withRetry(() => exchange.cancel({
                            cancels: [{a: assetId, o: makerOrderId!}],
                        }));
                        const cancelStatus = cancelResult.response.data.statuses[0];
                        if (cancelStatus === undefined) {
                            // Отмечаем отсутствие подтверждения отмены; IOC запускаться не должен.
                            console.log(`[HL maker] No cancellation status returned for ${coin}; IOC fallback blocked`);
                            throw new Error(`Hyperliquid returned no cancellation status for ${coin}; no IOC order was submitted`);
                        }
                        // Выводим результат биржи по запросу отмены.
                        console.log(`[HL maker] Cancellation response for ${coin}: ${JSON.stringify(cancelStatus)}`);

                        // Повторно проверяем ордер, потому что он мог исполниться во время отмены.
                        console.log(`[HL maker] Rechecking final status after cancellation for ${coin}; oid=${makerOrderId}`);
                        const finalStatus = await getMakerOrderSnapshot(info, address, makerOrderId);
                        if (finalStatus.status === "open" || finalStatus.status === "triggered") {
                            // Показываем, что ордер остался активным и добивать его нельзя.
                            console.log(`[HL maker] ${coin} remains ${finalStatus.status} after cancellation; IOC fallback blocked`);
                            throw new Error(
                                `Maker order for ${coin} remains open after cancellation; no IOC order was submitted`
                            );
                        }
                        orderStatus = finalStatus;
                        // Указываем состояние лимитки после подтвержденной отмены/исполнения.
                        console.log(`[HL maker] Final ${coin} order status after cancellation: ${orderStatus.status} from ${orderStatus.source}`);
                    }

                    if (orderStatus) {
                        const filledSize = getFilledOrderSize(orderStatus, requestedSize);
                        remainingSize = Math.max(0, requestedSize - filledSize);
                        // Сравниваем исполненный лимиткой объем с требуемым и показываем остаток.
                        console.log(`Hyperliquid maker order ${coin}: filled ${filledSize} of ${requestedSize}`);
                        console.log(`[HL maker] ${coin}: filled=${filledSize}, remaining=${remainingSize}`);
                    }
                } else if (submission.makerWasFilled) {
                    // Исполнение уже получено из ответа exchange.order; не делаем лишний status lookup.
                    console.log(`[HL maker] ${coin} immediate fill confirmed; remaining=${remainingSize}`);
                } else {
                    // Для отклоненного maker-ордера весь исходный объем передается в IOC.
                    console.log(`[HL maker] ${coin} was rejected; full size ${remainingSize} queued for IOC`);
                }

                if (remainingSize === 0) {
                    // Отмечаем завершение без taker-ордера, если maker полностью исполнился.
                    console.log(`[HL orders] ${coin} fully completed in maker phase; IOC not needed`);
                    return undefined;
                }

                // Показываем получение свежего mid перед расчетом taker-лимита.
                console.log(`[HL taker] Loading fresh mid for ${coin}; fallback size=${remainingSize}`);
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
                // Печатаем параметры IOC и лимит отклонения до отправки taker-добивания.
                console.log(
                    `[HL taker] Sending IOC ${coin} ${isBuy ? "BUY" : "SELL"} ${fallbackOrder.s} @ ${fallbackOrder.p}; mid=${fallbackMid}; slippageLimit=${IOC_SLIPPAGE * 100}%; cloid=${fallbackOrder.c}; reduceOnly=${reduceOnly}`
                );
                const fallbackSubmittedAt = Date.now();
                const fallbackResult = await withRetry(() => exchange.order({
                    orders: [fallbackOrder],
                    grouping: "na",
                }));
                const fallbackStatuses = fallbackResult.response.data.statuses;
                if (fallbackStatuses.length !== 1) {
                    // Показываем некорректное число результатов taker-ордера.
                    console.log(`[HL taker] ${coin} returned ${fallbackStatuses.length} IOC status(es), expected 1`);
                    throw new Error(
                        `Hyperliquid returned ${fallbackStatuses.length} IOC statuses for ${coin} fallback`
                    );
                }

                const fallbackStatus = fallbackStatuses[0]!;
                if (typeof fallbackStatus !== "object" || fallbackStatus === null || !("filled" in fallbackStatus)) {
                    // Показываем ответ биржи, если IOC не завершился исполнением.
                    console.log(`[HL taker] IOC was not filled for ${coin}: ${JSON.stringify(fallbackStatus)}`);
                    throw new Error(`Hyperliquid IOC fallback for ${coin} was not filled: ${JSON.stringify(fallbackStatus)}`);
                }

                const filledSize = Number(fallbackStatus.filled.totalSz);
                const avgPrice = Number(fallbackStatus.filled.avgPx);
                if (!Number.isFinite(filledSize) || !Number.isFinite(avgPrice) || filledSize <= 0 || avgPrice <= 0) {
                    // Показываем некорректные значения исполнения из ответа биржи.
                    console.log(`[HL taker] Invalid IOC fill values for ${coin}: size=${fallbackStatus.filled.totalSz}, avgPrice=${fallbackStatus.filled.avgPx}`);
                    throw new Error(`Hyperliquid returned invalid IOC fill data for ${coin}`);
                }
                if (filledSize < Number(fallbackSize)) {
                    // Выводим частичный результат IOC перед сообщением об ошибке.
                    console.log(`[HL taker] Partial IOC fill for ${coin}: ${filledSize} of ${fallbackSize}`);
                    throw new Error(
                        `Hyperliquid IOC fallback for ${coin} was only partially filled: ${filledSize} of ${fallbackSize}`
                    );
                }

                let verifiedFillData: {
                    averagePrice: number;
                    totalValue: number;
                    fee: number;
                    feeToken: string;
                    liquidityRole: string;
                } | undefined;
                try {
                    const fills = await withRetry(() => info.userFillsByTime({
                        user: address,
                        startTime: fallbackSubmittedAt,
                        endTime: Date.now(),
                    }));
                    const orderFills = fills.filter(
                        fill => fill.oid === fallbackStatus.filled.oid && fill.coin === coin
                    );
                    if (orderFills.length === 0) {
                        throw new Error(`No user fills found for IOC order ${fallbackStatus.filled.oid}`);
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
                        throw new Error(`Hyperliquid returned invalid fill details for ${coin}`);
                    }
                    const filledSizeFromTrades = fillValues.reduce((total, fill) => total + fill.size, 0);
                    const sizeTolerance = Math.max(1e-12, filledSize * 1e-9);
                    if (Math.abs(filledSizeFromTrades - filledSize) > sizeTolerance) {
                        throw new Error(
                            `Fill history for ${coin} order ${fallbackStatus.filled.oid} reports ${filledSizeFromTrades} of ${filledSize}`
                        );
                    }

                    const feeTokens = new Set(orderFills.map(fill => fill.feeToken));
                    if (feeTokens.size !== 1) {
                        throw new Error(`Hyperliquid returned multiple fee tokens for ${coin} IOC fills`);
                    }
                    const totalValueFromTrades = fillValues.reduce(
                        (total, fill) => total + fill.size * fill.price,
                        0
                    );
                    const crossedValues = new Set(orderFills.map(fill => fill.crossed));
                    const liquidityRole = crossedValues.size > 1
                        ? "Mixed maker/taker"
                        : orderFills[0]!.crossed ? "Taker" : "Maker";
                    verifiedFillData = {
                        averagePrice: totalValueFromTrades / filledSizeFromTrades,
                        totalValue: totalValueFromTrades,
                        fee: fillValues.reduce((total, fill) => total + fill.fee, 0),
                        feeToken: orderFills[0]!.feeToken,
                        liquidityRole,
                    };
                } catch (error) {
                    console.error(
                        `[HL orders] Could not verify actual fee and maker/taker role for ${coin} IOC fill; refusing to estimate them as taker`,
                        error
                    );
                }

                const executionPrice = verifiedFillData?.averagePrice ?? avgPrice;
                const totalValue = verifiedFillData?.totalValue ?? filledSize * avgPrice;
                const priceDiff = executionPrice - fallbackMid;
                const lossPerUnit = isBuy ? priceDiff : -priceDiff;
                const slippageLossUsdc = lossPerUnit * filledSize;
                const slippagePercent = (lossPerUnit / fallbackMid) * 100;
                const totalOrderLoss = verifiedFillData
                    ? verifiedFillData.fee + Math.max(0, slippageLossUsdc)
                    : undefined;

                // Разделитель обозначает отчет фактических исполнений по данным биржи.
                console.log(`==================================================`);
                // Показываем направление сделки, исполненный объем и монету.
                console.log(`🔔 HL СДЕЛКА ИСПОЛНЕНА: ${action.toUpperCase()} ${filledSize} ${coin}`);
                // Показываем цену исполнения относительно mid, использованного для IOC.
                console.log(`   ├─ Цена исполнения: ${executionPrice} USDC (Mid цена: ${fallbackMid} USDC)`);
                // Показываем денежный номинал исполненного объема.
                console.log(`   ├─ Общий объем:     ${totalValue.toFixed(4)} USDC`);
                if (verifiedFillData) {
                    console.log(
                        `   ├─ 💸 Комиссия (${verifiedFillData.liquidityRole}, биржевые fills): ${verifiedFillData.fee.toFixed(6)} ${verifiedFillData.feeToken}`
                    );
                } else {
                    console.log("   ├─ 💸 Комиссия / maker-taker: не удалось подтвердить по биржевым fills");
                }
                // Показываем потери от неблагоприятного отклонения цены.
                console.log(`   ├─ 📉 Потери от проскальзывания: ${Math.max(0, slippageLossUsdc).toFixed(6)} USDC (${slippagePercent.toFixed(4)}%)`);
                if (totalOrderLoss !== undefined) {
                    console.log(`   └─ 🛑 ИТОГО ИЗДЕРЖКИ НА ВХОДЕ: ${totalOrderLoss.toFixed(6)} USDC (${(totalOrderLoss / totalValue * 100).toFixed(4)}%)`);
                } else {
                    console.log("   └─ 🛑 ИТОГО ИЗДЕРЖКИ НА ВХОДЕ: не рассчитаны без подтвержденной комиссии");
                }
                // Закрываем отчет по исполненным сделкам.
                console.log(`==================================================`);
                return undefined;
            } catch (error) {
                // Печатаем ошибку обработки монеты перед сбором ошибок параллельного этапа.
                console.log(`[HL orders] Processing failed for ${coin}: ${String(error)}`);
                return new Error(`Perpetual order processing failed for ${coin}`, {cause: error});
            }
        }));

        const fallbackErrors = fallbackResults.filter((result): result is Error => result !== undefined);
        if (fallbackErrors.length > 0) {
            // Показываем число ошибок после завершения всех параллельных maker/taker-процессов.
            console.log(`[HL orders] Completed parallel fallback phase with ${fallbackErrors.length} error(s)`);
            throw new AggregateError(fallbackErrors, "One or more Hyperliquid IOC fallback orders failed");
        }
        // Подтверждаем успешное завершение всех ордеров.
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
