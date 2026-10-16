import type {LendingLeverageResult} from "../utils/invest_legal/recommend.js";
import {getEnv} from "../config.js";

export const LENDING_BOT_URL = "https://invest.legal/bot/lendingCorrection";

export type PositionAssets = {
    supply: Record<string, number>;
    borrow: Record<string, number>;
};

export abstract class Position {
    assets: PositionAssets = {
        supply: {},
        borrow: {},
    };

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

    protected createReportParams(lendingId: number): URLSearchParams {
        return new URLSearchParams({
            tg_id: getEnv("TG_ID"),
            lending_id: String(lendingId),
        });
    }

    protected createReportUrl(params: URLSearchParams): URL {
        const url = new URL(LENDING_BOT_URL);
        url.search = params.toString();
        return url;
    }
}
