import {WATCH_ADDRESS} from "../../config.js";
import {transformHyperliquidToLandingModel} from "./transformer.js";

const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";

type HyperliquidPosition = {
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
    marginSummary: {
        accountValue: string;
    };
    assetPositions: {
        position: HyperliquidPosition;
    }[];
};

type SpotUserBalances = {
    balances: SpotTokenBalance[];
};

type SpotTokenBalance = {
    coin: string;
    total: string;
    hold: string;
    entryPx: string;
};

type SpotClearinghouseState = {
    balances: SpotTokenBalance[];
};

function isSpotClearinghouseState(value: unknown): value is SpotClearinghouseState {
    return isRecord(value)
        && Array.isArray(value.balances)
        && value.balances.every((entry: unknown) =>
            isRecord(entry)
            && typeof entry.coin === "string"
            && isNumericString(entry.total)
        );
}


function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function isNumericString(value: unknown): value is string {
    return typeof value === "string" && Number.isFinite(Number(value));
}

function isHyperliquidPosition(value: unknown): value is HyperliquidPosition {
    if (!isRecord(value) || !isRecord(value.leverage)) {
        return false;
    }

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
        && Array.isArray(value.assetPositions)
        && value.assetPositions.every((entry: unknown) =>
            isRecord(entry) && isHyperliquidPosition(entry.position));
}

// --- Валидатор для Спота ---
function isSpotUserBalances(value: unknown): value is SpotUserBalances {
    return isRecord(value)
        && Array.isArray(value.balances)
        && value.balances.every((entry: unknown) =>
            isRecord(entry)
            && typeof entry.coin === "string"
            && isNumericString(entry.total)
        );
}

// Универсальный метод для отправки запросов к API info
async function postToHyperliquidInfo(type: string): Promise<unknown> {
    const response = await fetch(HYPERLIQUID_INFO_URL, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
            type: type,
            user: WATCH_ADDRESS,
        }),
        signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
        throw new Error(`Hyperliquid API returned HTTP ${response.status} for type ${type}`);
    }

    return response.json();
}

export async function getHyperliquidPositions(): Promise<boolean> {
    console.log("--- Hyperliquid Account ---");
    console.log(`User: ${WATCH_ADDRESS}`);

    try {
        // Делаем запросы параллельно к правильным эндпоинтам Hyperliquid
        const [marginRes, spotRes] = await Promise.all([
            postToHyperliquidInfo("clearinghouseState"),
            postToHyperliquidInfo("spotClearinghouseState") // <-- ИСПРАВЛЕНО ЗДЕСЬ
        ]);

        if (!isClearinghouseState(marginRes)) {
            throw new Error("Unexpected Hyperliquid clearinghouse state response");
        }

        if (!isSpotClearinghouseState(spotRes)) { // <-- ИСПРАВЛЕНО ЗДЕСЬ
            throw new Error("Unexpected Hyperliquid spot clearinghouse state response");
        }


        // 1. Ищем баланс USDC на споте
        const usdcSpot = spotRes.balances.find(b => b.coin === "USDC");
        const totalUsdcSpotValue = usdcSpot ? Number(usdcSpot.total) : 0;

// 2. Считаем суммарный нереализованный PnL по всем фьючерсным позициям
        const positions = marginRes.assetPositions
            .map(({position}) => position)
            .filter(position => Number(position.szi) !== 0);

        const totalUnrealizedPnl = positions.reduce(
            (sum, position) => sum + Number(position.unrealizedPnl),
            0
        );

        // 3. Вычисляем итоговый Total Equity в стиле веб-интерфейса Hyperliquid
        const totalEquity = totalUsdcSpotValue + totalUnrealizedPnl;

        console.log(`Total Balance (Site Style): ${totalEquity.toFixed(6)} USDC`);
        console.log(`  ├─ Spot Wallet Component: ${totalUsdcSpotValue.toFixed(6)} USDC`);
        console.log(`  └─ Total Perps uPnL: ${totalUnrealizedPnl.toFixed(6)} USDC`);

        const longs = positions.filter(position => Number(position.szi) > 0);
        const shorts = positions.filter(position => Number(position.szi) < 0);

        for (const [side, sidePositions] of [["LONG", longs], ["SHORT", shorts]] as const) {
            const totalValue = sidePositions.reduce(
                (sum, position) => sum + Number(position.positionValue),
                0
            );

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

        // Находим totalEquity по нашей финальной формуле (чистый баланс спота USDC)
        /// const usdcSpot = spotRes.balances.find(b => b.coin === "USDC");
        /// const totalEquity = usdcSpot ? Number(usdcSpot.total) : 0;

        // Вызываем трансформер
        const landingModel = transformHyperliquidToLandingModel({
            totalEquity,
            longs,
            shorts
        });

// Теперь landingModel.supply и landingModel.borrow содержат готовые массивы
        console.log("--- Сгенерированная модель для Лендинга ---");
        console.log("Supply Model (Залоги):", landingModel.supply);
        console.log("Borrow Model (Займы):", landingModel.borrow);

// Передаем эти списки в ваши существующие калькуляторы нетто-депозита и плеча
// const myNetEquity = myCalculator.calculateNet(landingModel.supply, landingModel.borrow);


        return true;
    } catch (error) {
        console.error("Ошибка при получении позиций Hyperliquid:", error);

        return false;
    }
}
