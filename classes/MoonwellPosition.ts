import {ethers, formatUnits} from "ethers";
import {
    BASE_CHAIN,
    CONFIG,
    getEnv,
    getMoonwellMarkets,
    LENDING,
    OPT_CHAIN,
    POOLS,
    type ChainType,
    type SupportedToken,
    type WalletBalances,
    WATCH_ADDRESS
} from "../config.js";
import {Position} from "./Position.js";
import {
    type LendingLeverageInstruction,
    fetchLendingInstruction,
    type LendingLeverageResult
} from "../utils/invest_legal/recommend.js";
import {borrowMoonwellAsset} from "../utils/moonwell/borrowAsset.js";
import {repayMoonwellAsset} from "../utils/moonwell/repayAsset.js";
import {supplyMoonwellAsset} from "../utils/moonwell/supplyMoonwellAsset.js";
import {withdrawMoonwellAsset} from "../utils/moonwell/withdrawMoonwellAsset.js";
import {swapEthToOp, swapToEth} from "../utils/uniswap/swap.js";
import {getUniswapPoolPrice, getWalletBalances, sleep, withRetry} from "../utils/utils.js";
import {wallets} from "../utils/loadWallet.js";

const SUPPORTED_CHAINS: readonly ChainType[] = [BASE_CHAIN, OPT_CHAIN];

function getHumanBalance(balances: WalletBalances, token: SupportedToken): number {
    const balance = balances[token];
    if (!balance) {
        throw new Error(`Wallet balance for ${token} is missing`);
    }

    return balance.human;
}

export class MoonwellPosition extends Position {
    protected readonly lendingId = 4;
    static readonly SUPPORTED_CHAINS: ChainType[] = [BASE_CHAIN, OPT_CHAIN];

    protected positionLoaded = false;

    async getPosition(): Promise<boolean> {
        super.getPosition();

        const network = CONFIG.NETWORKS[this.chain];
        const moonwellConfig = network.MOONWELL;
        if (!moonwellConfig) {
            throw new Error(`Moonwell is not configured for chain ${this.chain}`);
        }

        const comptroller = new ethers.Contract(
            moonwellConfig.COMPTROLLER,
            CONFIG.ABI.MOONWELL,
            this.provider
        );

        try {
            const tgId = getEnv("TG_ID");
            const chainConfig = LENDING[this.chain as keyof typeof LENDING];
            const userConfig = chainConfig?.[tgId as keyof typeof chainConfig];
            if (!userConfig) {
                throw new Error(`Lending configuration is missing for user ${tgId} on ${this.chain}`);
            }

            const markets: string[] = await withRetry<string[]>(() => (comptroller as any).getAllMarkets());

            for (const mTokenAddress of markets) {
                const mToken = new ethers.Contract(mTokenAddress, CONFIG.ABI.MOONWELL, this.provider);
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
                    if (pairId !== undefined) this.assets.supply[pairId] = Number(formattedSupply);
                }

                if (borrowBalance > 0n) {
                    const formattedBorrow = formatUnits(borrowBalance, CONFIG.TOKEN_DECIMALS[underlyingSymbol]);
                    console.log(`🔴 Заем (Liability)   -> ${formattedBorrow} ${underlyingSymbol}`);
                    if (pairId !== undefined) this.assets.borrow[pairId] = Number(formattedBorrow);
                }

                const [formattedSupplyAPY, formattedBorrowAPY] = await this.calculateMoonwellAPY(mToken);
                console.log(borrowBalance > 0n
                    ? `Borrow APY: ${formattedBorrowAPY}`
                    : `Supply APY: ${formattedSupplyAPY}`);
            }

            this.positionLoaded = true;
            return true;
        } catch (err) {
            console.error("Ошибка при получении позиций Moonwell:", err);
            return false;
        }
    }

    async reportPosition(): Promise<boolean> {
        if (!this.positionLoaded) {
            throw new Error("Call getPosition() before reportPosition()");
        }

        try {
            const url = this.createReportUrl(this.createReportParams(this.assets));
            const response = await fetch(url.href);
            const text = await response.text();
            console.log(url.href, text);
            return text === "OK";
        } catch (err) {
            console.error("Ошибка при отправке позиций Moonwell:", err);
            return false;
        }
    }

    async loop(amount: number, instruction: LendingLeverageInstruction): Promise<void> {
        if (!wallets[this.chain]) return;

        let walletBalances = await getWalletBalances(this.chain, this.provider) as WalletBalances;
        let numTry = 0;

        if (getHumanBalance(walletBalances, "ETH") < 0.01) {
            if (getHumanBalance(walletBalances, "OP") < amount) {
                console.log(await borrowMoonwellAsset(this.chain, "OP", amount));
            }

            const hasEth = getHumanBalance(walletBalances, "ETH");
            while (true) {
                numTry++;
                await sleep(5000);
                try {
                    walletBalances = await getWalletBalances(this.chain, this.provider) as WalletBalances;
                    if (getHumanBalance(walletBalances, "ETH") > hasEth) {
                        console.log("ETH от обмена поступил на баланс кошелька");
                        break;
                    }

                    if (getHumanBalance(walletBalances, "OP") < amount) {
                        console.log("Ожидается поступление OP на баланс кошелька....");
                        if (numTry < 5) continue;
                        break;
                    }

                    let quote = await getUniswapPoolPrice(this.chain, POOLS.OPT.EthOp03, this.provider);
                    quote = 1 / quote;
                    console.log(await swapToEth(this.chain, "OP", getHumanBalance(walletBalances, "OP"), quote));
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
                walletBalances = await getWalletBalances(this.chain, this.provider) as WalletBalances;
                if (getHumanBalance(walletBalances, "ETH") > 0.01) {
                    status = "trySupply";
                    await supplyMoonwellAsset(this.chain, "ETH", (walletBalances.ETH?.human ?? 0) - 0.004);
                    break;
                }

                if (status === "trySupply" && getHumanBalance(walletBalances, "ETH") < 0.01) break;
            } catch (err) {
                console.error(err);
            }
        }
    }

    async deLoop(amount: number, instruction: LendingLeverageInstruction): Promise<void> {
        if (!wallets[this.chain]) return;

        let walletBalances = await getWalletBalances(this.chain, this.provider) as WalletBalances;
        let numTry = 0;

        if (getHumanBalance(walletBalances, "OP") < amount * 0.9) {
            const quote = await getUniswapPoolPrice(this.chain, POOLS.OPT.EthOp03, this.provider);
            if (getHumanBalance(walletBalances, "ETH") < 0.01) {
                console.log(await withdrawMoonwellAsset(this.chain, this.provider, "ETH", amount / quote));
            }

            const hasOp = getHumanBalance(walletBalances, "OP");
            while (true) {
                numTry++;
                await sleep(5000);
                try {
                    walletBalances = await getWalletBalances(this.chain, this.provider) as WalletBalances;
                    if (getHumanBalance(walletBalances, "OP") > hasOp) {
                        console.log("OP от обмена поступил на баланс кошелька");
                        break;
                    }

                    if (getHumanBalance(walletBalances, "ETH") < amount / quote * 0.9) {
                        console.log("Ожидается поступление ETH на баланс кошелька....");
                        if (numTry < 5) continue;
                        break;
                    }

                    console.log(await swapEthToOp(this.chain, "OP", getHumanBalance(walletBalances, "ETH") - 0.004, quote));
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
                walletBalances = await getWalletBalances(this.chain, this.provider) as WalletBalances;
                if (getHumanBalance(walletBalances, "OP") > amount * 0.9) {
                    status = "tryRepay";
                    console.log(await repayMoonwellAsset(this.chain, "OP", getHumanBalance(walletBalances, "OP")));
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
