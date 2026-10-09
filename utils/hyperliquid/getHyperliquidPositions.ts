import {WATCH_ADDRESS} from "../../config.js";

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

async function fetchClearinghouseState(): Promise<unknown> {
    const response = await fetch(HYPERLIQUID_INFO_URL, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
            type: "clearinghouseState",
            user: WATCH_ADDRESS,
        }),
        signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
        throw new Error(`Hyperliquid API returned HTTP ${response.status}`);
    }

    return response.json();
}

export async function getHyperliquidPositions(): Promise<boolean> {
    console.log("--- Hyperliquid Account ---");
    console.log(`User: ${WATCH_ADDRESS}`);

    try {
        const response = await fetchClearinghouseState();
        if (!isClearinghouseState(response)) {
            throw new Error("Unexpected Hyperliquid clearinghouse state response");
        }

        console.log(`Total equity: ${response.marginSummary.accountValue} USDC`);

        const positions = response.assetPositions
            .map(({position}) => position)
            .filter(position => Number(position.szi) !== 0);
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

        return true;
    } catch (error) {
        console.error("Ошибка при получении позиций Hyperliquid:", error);
        return false;
    }
}
