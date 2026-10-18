import type {LendingLeverageResult} from "../utils/invest_legal/recommend.js";
import {BASE_CHAIN, type ChainType, getEnv} from "../config.js";
import {ethers} from "ethers";

export const LENDING_BOT_URL = "https://invest.legal/bot/lendingCorrection";

export type PositionAssets = {
    supply: Record<string, number>;
    borrow: Record<string, number>;
};

export abstract class Position {
    protected abstract readonly lendingId: number;
    static readonly SUPPORTED_CHAINS: ChainType[] = [];

    assets: PositionAssets = {
        supply: {},
        borrow: {},
    };

    constructor(
        protected readonly chain: ChainType,
        protected readonly provider: ethers.JsonRpcProvider
    ) {
        // Достаем статическое свойство из текущего класса-наследника
        const CurrentClass = this.constructor as typeof Position & { SUPPORTED_CHAINS?: ChainType[] };
        const supported = CurrentClass.SUPPORTED_CHAINS || [];

        if (!supported.includes(chain)) {
            throw new Error(`${this.constructor.name} is not supported for chain ${chain}`);
        }
    }

    abstract getPosition(): Promise<boolean>;
    abstract reportPosition(): Promise<boolean>;

    async getRecommend(): Promise<LendingLeverageResult> {
        throw new Error(`${this.constructor.name} does not support recommendations`);
    }

    async loop(_amount: number): Promise<void> {
        throw new Error(`${this.constructor.name} does not support looping`);
    }

    async deLoop(_amount: number): Promise<void> {
        throw new Error(`${this.constructor.name} does not support de-looping`);
    }

    protected createReportParams(assets: PositionAssets): URLSearchParams {
        const params = new URLSearchParams({
            tg_id: getEnv("TG_ID"),
            lending_id: String(this.lendingId),
        });

        for (const [key, amount] of Object.entries(assets.supply)) {
            params.set(`supply_${key}`, String(amount));
        }
        for (const [key, amount] of Object.entries(assets.borrow)) {
            params.set(`borrow_${key}`, String(amount));
        }

        return params;
    }

    protected createReportUrl(params: URLSearchParams): URL {
        const url = new URL(LENDING_BOT_URL);
        url.search = params.toString();

        return url;
    }
}
