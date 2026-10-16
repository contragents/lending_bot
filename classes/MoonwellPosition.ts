import {ethers, formatUnits} from "ethers";
import {CHAIN, CONFIG, currentNetwork, getEnv, LENDING, OPT_CHAIN, POOLS, provider, type SupportedToken, type WalletBalances, WATCH_ADDRESS} from "../config.js";
import {Position} from "./Position.js";
import {fetchLendingInstruction, type LendingLeverageResult} from "../utils/invest_legal/recommend.js";
import {borrowMoonwellAsset} from "../utils/moonwell/borrowAsset.js";
import {repayMoonwellAsset} from "../utils/moonwell/repayAsset.js";
import {supplyMoonwellAsset} from "../utils/moonwell/supplyMoonwellAsset.js";
import {withdrawMoonwellAsset} from "../utils/moonwell/withdrawMoonwellAsset.js";
import {swapEthToOp, swapToEth} from "../utils/uniswap/swap.js";
import {getUniswapPoolPrice, getWalletBalances, sleep, withRetry} from "../utils/utils.js";
import {wallet} from "../utils/loadWallet.js";

function getHumanBalance(balances: WalletBalances, token: SupportedToken): number {
    const balance = balances[token];
    if (!balance) {
        throw new Error(`Wallet balance for ${token} is missing`);
    }

    return balance.human;
}

export class MoonwellPosition extends Position {
    private reportParams: URLSearchParams | undefined;

    async getPosition(): Promise<boolean> {
        this.reportParams = undefined;
        console.log(`--- Moonwell Assets & Liabilities (${CHAIN}) ---`);
        const moonwellConfig = currentNetwork.MOONWELL;
        if (!moonwellConfig) {
            throw new Error(`Moonwell is not configured for chain ${CHAIN}`);
        }

        const comptroller = new ethers.Contract(
            moonwellConfig.COMPTROLLER,
            CONFIG.ABI.MOONWELL,
            provider
        );

        try {
            const tgId = getEnv("TG_ID");
            const chainConfig = LENDING[CHAIN as keyof typeof LENDING];
            const userConfig = chainConfig?.[tgId as keyof typeof chainConfig];
            if (!userConfig) {
                throw new Error(`Lending configuration is missing for user ${tgId} on ${CHAIN}`);
            }

            const params = this.createReportParams(userConfig.ID);
            const markets: string[] = await withRetry<string[]>(() => (comptroller as any).getAllMarkets());

            for (const mTokenAddress of markets) {
                const mToken = new ethers.Contract(mTokenAddress, CONFIG.ABI.MOONWELL, provider);
                const [error, mTokenBalance, borrowBalance, exchangeRate] =
                    await withRetry<[bigint, bigint, bigint, bigint]>(() =>
                        (mToken as any).getAccountSnapshot(WATCH_ADDRESS)
                    );

                if (error !== 0n || (mTokenBalance === 0n && borrowBalance === 0n)) continue;

                const mTokenSymbol = await withRetry<string>(() => (mToken as any).symbol());
                const underlyingSymbol = mTokenSymbol.substring(1) as SupportedToken;
                const pairId = userConfig.PAIR_IDS[underlyingSymbol as keyof typeof userConfig.PAIR_IDS];

                if (mTokenBalance > 0n) {
                    const underlyingAmountWei = BigInt(mTokenBalance * exchangeRate) / ethers.parseEther("1");
                    const formattedSupply = formatUnits(underlyingAmountWei, CONFIG.TOKEN_DECIMALS[underlyingSymbol]);
                    console.log(`🟢 Снабжение (Asset)  -> ${formattedSupply} ${underlyingSymbol}`);
                    if (pairId !== undefined) params.set(`supply_${pairId}`, formattedSupply);
                }

                if (borrowBalance > 0n) {
                    const formattedBorrow = formatUnits(borrowBalance, CONFIG.TOKEN_DECIMALS[underlyingSymbol]);
                    console.log(`🔴 Заем (Liability)   -> ${formattedBorrow} ${underlyingSymbol}`);
                    if (pairId !== undefined) params.set(`borrow_${pairId}`, formattedBorrow);
                }

                const [formattedSupplyAPY, formattedBorrowAPY] = await this.calculateMoonwellAPY(mToken);
                console.log(borrowBalance > 0n
                    ? `Borrow APY: ${formattedBorrowAPY}`
                    : `Supply APY: ${formattedSupplyAPY}`);
            }

            this.reportParams = params;
            return true;
        } catch (err) {
            console.error("Ошибка при получении позиций Moonwell:", err);
            return false;
        }
    }

    async reportPosition(): Promise<boolean> {
        if (!this.reportParams) {
            throw new Error("Call getPosition() before reportPosition()");
        }

        try {
            const url = this.createReportUrl(this.reportParams);
            const response = await fetch(url.href);
            const text = await response.text();
            console.log(url.href, text);
            return text === "OK";
        } catch (err) {
            console.error("Ошибка при отправке позиций Moonwell:", err);
            return false;
        }
    }

    async getRecommend(): Promise<LendingLeverageResult> {
        const tgId = getEnv("TG_ID");
        const chainConfig = LENDING[CHAIN as keyof typeof LENDING];
        const userConfig = chainConfig?.[tgId as keyof typeof chainConfig];
        if (!userConfig) {
            throw new Error(`Lending configuration is missing for user ${tgId} on ${CHAIN}`);
        }

        return fetchLendingInstruction(userConfig.ID);
    }

    async loop(borrowAmount: number): Promise<void> {
        let walletBalances = await getWalletBalances() as WalletBalances;
        let numTry = 0;

        if (getHumanBalance(walletBalances, "ETH") < 0.01) {
            if (getHumanBalance(walletBalances, "OP") < borrowAmount) {
                console.log(await borrowMoonwellAsset("OP", borrowAmount));
            }

            const hasEth = getHumanBalance(walletBalances, "ETH");
            while (true) {
                numTry++;
                await sleep(5000);
                try {
                    walletBalances = await getWalletBalances() as WalletBalances;
                    if (getHumanBalance(walletBalances, "ETH") > hasEth) {
                        console.log("ETH от обмена поступил на баланс кошелька");
                        break;
                    }

                    if (getHumanBalance(walletBalances, "OP") < borrowAmount) {
                        console.log("Ожидается поступление OP на баланс кошелька....");
                        if (numTry < 5) continue;
                        break;
                    }

                    let quote = await getUniswapPoolPrice(POOLS.OPT.EthOp03, provider);
                    quote = 1 / quote;
                    console.log(await swapToEth("OP", getHumanBalance(walletBalances, "OP"), quote));
                } catch (err) {
                    console.error(err);
                }
            }
        }

        let status = "waitForEth";
        numTry = 0;
        while (true) {
            numTry++;
            if (numTry > 5) break;
            await sleep(5000);

            try {
                walletBalances = await getWalletBalances() as WalletBalances;
                if (getHumanBalance(walletBalances, "ETH") > 0.01) {
                    status = "trySupply";
                    await supplyMoonwellAsset("ETH", (walletBalances.ETH?.human ?? 0) - 0.004);
                    break;
                }

                if (status === "trySupply" && getHumanBalance(walletBalances, "ETH") < 0.01) break;
            } catch (err) {
                console.error(err);
            }
        }
    }

    async deLoop(supplyAmount: number): Promise<void> {
        let walletBalances = await getWalletBalances() as WalletBalances;
        let numTry = 0;

        if (getHumanBalance(walletBalances, "OP") < supplyAmount * 0.9) {
            const quote = await getUniswapPoolPrice(POOLS.OPT.EthOp03, provider);
            if (getHumanBalance(walletBalances, "ETH") < 0.01) {
                console.log(await withdrawMoonwellAsset("ETH", supplyAmount / quote));
            }

            const hasOp = getHumanBalance(walletBalances, "OP");
            while (true) {
                numTry++;
                await sleep(5000);
                try {
                    walletBalances = await getWalletBalances() as WalletBalances;
                    if (getHumanBalance(walletBalances, "OP") > hasOp) {
                        console.log("OP от обмена поступил на баланс кошелька");
                        break;
                    }

                    if (getHumanBalance(walletBalances, "ETH") < supplyAmount / quote * 0.9) {
                        console.log("Ожидается поступление ETH на баланс кошелька....");
                        if (numTry < 5) continue;
                        break;
                    }

                    console.log(await swapEthToOp("OP", getHumanBalance(walletBalances, "ETH") - 0.004, quote));
                } catch (err) {
                    console.error(err);
                }
            }
        }

        let status = "waitForOp";
        numTry = 0;
        while (true) {
            numTry++;
            await sleep(5000);

            try {
                walletBalances = await getWalletBalances() as WalletBalances;
                if (getHumanBalance(walletBalances, "OP") > supplyAmount * 0.9) {
                    status = "tryRepay";
                    console.log(await repayMoonwellAsset("OP", getHumanBalance(walletBalances, "OP")));
                    break;
                }

                if (status === "tryRepay" && getHumanBalance(walletBalances, "OP") < 10) break;
                if (numTry > 5) break;
            } catch (err) {
                console.error(err);
            }
        }
    }

    private async calculateMoonwellAPY(mToken: ethers.Contract): Promise<[string, string]> {
        try {
            const borrowRatePerTimestamp: bigint = await withRetry<bigint>(() =>
                (mToken as any).borrowRatePerTimestamp()
            );
            const supplyRatePerTimestamp: bigint = await withRetry<bigint>(() =>
                (mToken as any).supplyRatePerTimestamp()
            );
            const borrowRatePerSecond = Number(borrowRatePerTimestamp) / 1e18;
            const supplyRatePerSecond = Number(supplyRatePerTimestamp) / 1e18;
            const secondsPerYear = 365 * 24 * 60 * 60;
            const supplyAPY = (Math.pow(1 + supplyRatePerSecond, secondsPerYear) - 1) * 100;
            const borrowAPY = (Math.pow(1 + borrowRatePerSecond, secondsPerYear) - 1) * 100;

            return [supplyAPY.toFixed(2), borrowAPY.toFixed(2)];
        } catch (err) {
            console.error("Ошибка при расчете APY для токена:", err);

            return ["0.00", "0.00"];
        }
    }
}
