import {WATCH_ADDRESS} from "../../config.js";

const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";

type PositionAmount = {
    basis: string;
    value: string;
};

type BorrowLendTokenState = {
    borrow: PositionAmount;
    supply: PositionAmount;
};

type BorrowLendUserState = {
    tokenToState: [number, BorrowLendTokenState][];
    health: string;
    healthFactor: string | null;
};

type SpotToken = {
    index: number;
    name: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function isPositionAmount(value: unknown): value is PositionAmount {
    return isRecord(value)
        && typeof value.basis === "string"
        && Number.isFinite(Number(value.basis))
        && typeof value.value === "string"
        && Number.isFinite(Number(value.value));
}

function isBorrowLendUserState(value: unknown): value is BorrowLendUserState {
    return isRecord(value)
        && Array.isArray(value.tokenToState)
        && value.tokenToState.every((entry: unknown) =>
            Array.isArray(entry)
            && typeof entry[0] === "number"
            && isRecord(entry[1])
            && isPositionAmount(entry[1].borrow)
            && isPositionAmount(entry[1].supply))
        && typeof value.health === "string"
        && (value.healthFactor === null
            || (typeof value.healthFactor === "string" && Number.isFinite(Number(value.healthFactor))));
}

function isSpotMeta(value: unknown): value is { tokens: SpotToken[] } {
    return isRecord(value)
        && Array.isArray(value.tokens)
        && value.tokens.every((token: unknown) =>
            isRecord(token)
            && typeof token.index === "number"
            && typeof token.name === "string");
}

async function fetchInfo(payload: Record<string, string>): Promise<unknown> {
    const response = await fetch(HYPERLIQUID_INFO_URL, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
        throw new Error(`Hyperliquid API returned HTTP ${response.status}`);
    }

    return response.json();
}

export async function getHyperliquidPositions(): Promise<boolean> {
    console.log("--- Hyperliquid Borrow & Lend ---");
    console.log(`User: ${WATCH_ADDRESS}`);

    try {
        const userStateResponse = await fetchInfo({
            type: "borrowLendUserState",
            user: WATCH_ADDRESS,
        });
        if (!isBorrowLendUserState(userStateResponse)) {
            throw new Error("Unexpected borrow/lend user state response");
        }

        const activePositions = userStateResponse.tokenToState.filter(([, state]) =>
            Number(state.borrow.basis) !== 0
            || Number(state.borrow.value) !== 0
            || Number(state.supply.basis) !== 0
            || Number(state.supply.value) !== 0);

        console.log(`Account health: ${userStateResponse.health}`);
        if (userStateResponse.healthFactor !== null) {
            console.log(`Health factor: ${userStateResponse.healthFactor}`);
        }

        if (activePositions.length === 0) {
            console.log("Позиции lending в Hyperliquid не найдены.");
            return true;
        }

        const spotMetaResponse = await fetchInfo({type: "spotMeta"});
        if (!isSpotMeta(spotMetaResponse)) {
            throw new Error("Unexpected Hyperliquid spot metadata response");
        }
        const tokenNames = new Map(spotMetaResponse.tokens.map(token => [token.index, token.name]));

        for (const [tokenId, state] of activePositions) {
            const tokenName = tokenNames.get(tokenId) ?? `token#${tokenId}`;

            if (Number(state.supply.basis) !== 0 || Number(state.supply.value) !== 0) {
                console.log(
                    `🟢 Supply ${tokenName} -> principal ${state.supply.basis}, current ${state.supply.value}`
                );
            }

            if (Number(state.borrow.basis) !== 0 || Number(state.borrow.value) !== 0) {
                console.log(
                    `🔴 Borrow ${tokenName} -> principal ${state.borrow.basis}, current ${state.borrow.value}`
                );
            }
        }

        return true;
    } catch (error) {
        console.error("Ошибка при получении позиций Hyperliquid:", error);
        return false;
    }
}
