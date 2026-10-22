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

        const [mids, converter] = await Promise.all([
            withRetry(() => info.allMids()),
            withRetry(() => SymbolConverter.create({transport})),
        ]);
        // Показываем получение рыночных цен и таблицы параметров монет.
        console.log("[HL orders] Market mids and asset metadata loaded");
        const exchange = new ExchangeClient({transport, wallet});

        const preparedOrders = orderIntents.map(intent => {
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

            // Печатаем подготовленные сторону, размер, цену mid и идентификатор maker-ордера.
            console.log(
                `[HL maker] Prepared ${coin} ${isBuy ? "BUY" : "SELL"} ${makerSize} @ mid ${makerOrder.p}; cloid=${cloid}; reduceOnly=${reduceOnly}`
            );
            return {intent, assetId, sizeDecimals, requestedSize, cloid, makerOrder};
        });

        // Отмечаем одновременный старт выставления всех maker-лимиток.
        console.log(`[HL maker] Submitting ${preparedOrders.length} GTC order(s) in parallel`);
        const makerSubmissions = await Promise.all(preparedOrders.map(async preparedOrder => {
            const {intent, assetId, cloid, makerOrder} = preparedOrder;
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
                    return {preparedOrder, makerRejected: true as const};
                }
                // Подтверждаем, что maker-ордер принят биржей и далее будет отслеживаться.
                console.log(`[HL maker] ${intent.coin} GTC order accepted; cloid=${cloid}`);
                return {preparedOrder, makerRejected: false as const};
            } catch (error) {
                // Показываем сетевую/SDK ошибку отправки конкретного maker-ордера.
                console.log(`[HL maker] Submission failed for ${intent.coin}; fallback is blocked until order state is safe`);
                return {
                    preparedOrder,
                    error: new Error(`Maker order submission failed for ${intent.coin}`, {cause: error}),
                };
            }
        }));

        const submissionErrors = makerSubmissions.flatMap(result =>
            "error" in result ? [result.error] : []);
        if (submissionErrors.length > 0) {
            // Сообщаем о защитном запросе отмены после неподтвержденной отправки maker-ордера.
            console.log(`[HL maker] ${submissionErrors.length} submission error(s); requesting parallel cancellations before stopping`);
            const cancellationResults = await Promise.all(preparedOrders.map(async ({assetId, cloid}) => {
                try {
                    await withRetry(() => exchange.cancelByCloid({
                        cancels: [{asset: assetId, cloid}],
                    }));
                    // Показываем принятие запроса отмены в защитной ветке.
                    console.log(`[HL maker] Cancellation requested for cloid=${cloid}`);
                    return undefined;
                } catch (error) {
                    // Показываем ошибку отмены, чтобы она не потерялась среди исходных ошибок отправки.
                    console.log(`[HL maker] Cancellation request failed for cloid=${cloid}: ${String(error)}`);
                    return error;
                }
            }));
            const cancellationErrors = cancellationResults.filter(error => error !== undefined);
            throw new AggregateError(
                [...submissionErrors, ...cancellationErrors],
                "One or more maker orders could not be confirmed; cancellation was requested and no IOC orders were submitted"
            );
        }

        // Показываем начало общей паузы перед запросом статуса всех maker-ордеров.
        console.log(`[HL maker] All submissions resolved; waiting ${MAKER_ORDER_WAIT_MS} ms before status checks`);
        await sleep(MAKER_ORDER_WAIT_MS);
        // Отмечаем окончание паузы и начало параллельной проверки/добивания.
        console.log("[HL maker] Wait complete; checking maker statuses and starting IOC fallbacks in parallel");

        const fallbackResults = await Promise.all(makerSubmissions.map(async submission => {
            const {intent, assetId, sizeDecimals, requestedSize, cloid} = submission.preparedOrder;
            const {coin, isBuy, reduceOnly, action} = intent;
            try {
                let remainingSize = requestedSize;
                if (!submission.makerRejected) {
                    // Логируем запрос статуса конкретной лимитки по client order ID.
                    console.log(`[HL maker] Checking status for ${coin}; cloid=${cloid}`);
                    let orderStatus: Awaited<ReturnType<InfoClient["orderStatus"]>>;
                    try {
                        orderStatus = await withRetry(() => info.orderStatus({user: address, oid: cloid}));
                    } catch (error) {
                        // Сообщаем о невозможности проверить статус и о защитной отмене вместо IOC.
                        console.log(`[HL maker] Status check failed for ${coin}; requesting cancellation and skipping IOC`);
                        try {
                            await withRetry(() => exchange.cancelByCloid({
                                cancels: [{asset: assetId, cloid}],
                            }));
                            // Отмечаем, что отмена запрошена после сбоя чтения статуса.
                            console.log(`[HL maker] Cancellation requested after status error for ${coin}; cloid=${cloid}`);
                        } catch (cancelError) {
                            // Фиксируем ошибку отмены вместе с невозможностью проверить ордер.
                            console.log(`[HL maker] Cancellation also failed for ${coin}: ${String(cancelError)}`);
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
                        // Не отправляем taker-ордер, пока биржа не подтвердила судьбу неизвестной лимитки.
                        console.log(`[HL maker] Status is unknownOid for ${coin}; requesting cancellation and stopping fallback`);
                        try {
                            await withRetry(() => exchange.cancelByCloid({
                                cancels: [{asset: assetId, cloid}],
                            }));
                            // Отмечаем отправленный защитный запрос отмены неизвестной лимитки.
                            console.log(`[HL maker] Cancellation requested for unknown maker order ${coin}; cloid=${cloid}`);
                        } catch (cancelError) {
                            // Показываем неудачную отмену неизвестной лимитки.
                            console.log(`[HL maker] Cancellation failed for unknown maker order ${coin}: ${String(cancelError)}`);
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
                        // Показываем статус живой лимитки и запрос отмены ее остатка.
                        console.log(`[HL maker] ${coin} status=${orderStatus.order.status}; canceling remaining GTC size`);
                        const cancelResult = await withRetry(() => exchange.cancelByCloid({
                            cancels: [{asset: assetId, cloid}],
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
                        console.log(`[HL maker] Rechecking final status after cancellation for ${coin}; cloid=${cloid}`);
                        const finalStatus = await withRetry(() => info.orderStatus({user: address, oid: cloid}));
                        if (finalStatus.status === "unknownOid") {
                            // Не продолжаем при неизвестном результате финальной проверки.
                            console.log(`[HL maker] Final status is unknownOid for ${coin}; IOC fallback blocked`);
                            throw new Error(`Hyperliquid returned unknownOid after canceling maker order for ${coin}; no IOC order was submitted`);
                        }
                        if (finalStatus.order.status === "open" || finalStatus.order.status === "triggered") {
                            // Показываем, что ордер остался активным и добивать его нельзя.
                            console.log(`[HL maker] ${coin} remains ${finalStatus.order.status} after cancellation; IOC fallback blocked`);
                            throw new Error(
                                `Maker order for ${coin} remains open after cancellation; no IOC order was submitted`
                            );
                        }
                        orderStatus = finalStatus;
                        // Указываем состояние лимитки после подтвержденной отмены/исполнения.
                        console.log(`[HL maker] Final ${coin} order status after cancellation: ${orderStatus.order.status}`);
                    }

                    const filledSize = getFilledOrderSize(orderStatus, requestedSize);
                    remainingSize = Math.max(0, requestedSize - filledSize);
                    // Сравниваем исполненный лимиткой объем с требуемым и показываем остаток.
                    console.log(`Hyperliquid maker order ${coin}: filled ${filledSize} of ${requestedSize}`);
                    console.log(`[HL maker] ${coin}: filled=${filledSize}, remaining=${remainingSize}`);
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

                const totalValue = filledSize * avgPrice;
                const feePaidUsdc = totalValue * 0.00045;
                const priceDiff = avgPrice - fallbackMid;
                const lossPerUnit = isBuy ? priceDiff : -priceDiff;
                const slippageLossUsdc = lossPerUnit * filledSize;
                const slippagePercent = (lossPerUnit / fallbackMid) * 100;
                const totalOrderLoss = feePaidUsdc + Math.max(0, slippageLossUsdc);

                // Разделитель обозначает подробный отчет исполненного taker-ордера.
                console.log(`==================================================`);
                // Показываем направление сделки, исполненный объем и монету.
                console.log(`🔔 HL СДЕЛКА ИСПОЛНЕНА: ${action.toUpperCase()} ${filledSize} ${coin}`);
                // Показываем цену исполнения относительно mid, использованного для IOC.
                console.log(`   ├─ Цена исполнения: ${avgPrice} USDC (Mid цена: ${fallbackMid} USDC)`);
                // Показываем денежный номинал исполненного объема.
                console.log(`   ├─ Общий объем:     ${totalValue.toFixed(4)} USDC`);
                // Показываем расчетную taker-комиссию.
                console.log(`   ├─ 💸 Комиссия (Taker 0.045%):  ${feePaidUsdc.toFixed(6)} USDC`);
                // Показываем потери от неблагоприятного отклонения цены.
                console.log(`   ├─ 📉 Потери от проскальзывания: ${Math.max(0, slippageLossUsdc).toFixed(6)} USDC (${slippagePercent.toFixed(4)}%)`);
                // Показываем итоговую метрику потерь этого IOC-исполнения.
                console.log(`   └─ 🛑 ИТОГО ПОТЕРЬ НА ВХОДЕ:    ${Math.abs(1 - (totalOrderLoss - totalValue) / totalValue) * 100}%)`);
                // Закрываем подробный отчет по taker-сделке.
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
